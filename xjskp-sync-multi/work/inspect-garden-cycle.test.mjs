import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ITEM_IDS } from "./garden-state.mjs";
import { TARGET_FLOWER_RACK_ART_ID } from "./flower-rack-state.mjs";
import {
  CYCLIC_NOTE_ACTIVITY_TYPE,
  loadCyclicNoteConfig,
} from "./cyclic-note-state.mjs";
import {
  CYCLIC_STORY_ACTIVITY_TYPE,
  loadCyclicStoryConfig,
} from "./cyclic-story-state.mjs";
import {
  RESIDENT_ORDER_MAIN_TASK_TYPES,
  loadMainTaskConfig,
} from "./main-task-state.mjs";
import { createFlowerLevelConfig } from "./flower-level-config.mjs";
import { createCustomerOrderScheduler } from "./customer-order-scheduler.mjs";
import {
  createWaterwheelBucketState,
  saveWaterwheelBucketState,
} from "./waterwheel-bucket-state.mjs";
import {
  estimateExperienceAction,
  loadExperienceSettlementConfig,
} from "./experience-settlement.mjs";

const EXPECTED_DEFAULT_RACK_ART_ID = 301722;
const EXPECTED_DEFAULT_RACK_VASE_ID = 3017;
const EXPECTED_DEFAULT_RACK_FLOWER_IDS = [23126, 23104, 23105];

test("mergeAccountGatewaySync preserves the gateway's newest resident-order state", async () => {
  const { mergeAccountGatewaySync } = await import(
    `./inspect-garden-dryrun.mjs?gateway-order-reconcile=${Date.now()}`,
  );
  const callerSync = {
    callerOnly: { marker: "retain" },
    $usrTot: { data: { lvl: 19, lvlExp: 90, nextExp: 100 } },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { finishCnt: 2, cTime: "old-satin", isVideo: 0 },
        orderDecorate: { finishCnt: 2, cTime: "old-decorate", isVideo: 0 },
      },
    },
    orderCustomerTot: {
      orderCustomer: { orderMap: {} },
    },
  };
  const gatewaySync = {
    $usrTot: { data: { lvl: 19, lvlExp: 95, nextExp: 100 } },
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { finishCnt: 3, cTime: "new-satin", isVideo: 1 },
        orderDecorate: { finishCnt: 3, cTime: "new-decorate", isVideo: 1 },
      },
    },
    orderCustomerTot: {
      orderCustomer: {
        orderMap: { 9: { npcId: 9, artId: 300101, num: 1 } },
      },
    },
    $experienceGuardState: { armedLevel: 19, breached: false },
  };

  const merged = mergeAccountGatewaySync(callerSync, gatewaySync);

  assert.equal(merged.callerOnly.marker, "retain");
  assert.equal(merged.orderFlowerTot.orderFlower.orderSatin.finishCnt, 3);
  assert.equal(merged.orderFlowerTot.orderFlower.orderSatin.cTime, "new-satin");
  assert.equal(merged.orderFlowerTot.orderFlower.orderDecorate.finishCnt, 3);
  assert.deepEqual(merged.orderCustomerTot.orderCustomer.orderMap, {});
  assert.deepEqual(merged.$experienceGuardState, gatewaySync.$experienceGuardState);
  assert.equal(merged.$usrTot.data.lvlExp, 95);
});

test("successful WebSocket reconnect resumes the loop without a fixed three-second delay", () => {
  const source = fs.readFileSync(
    new URL("./inspect-garden-dryrun.mjs", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(
    source,
    /loopReconnectRetry", cycle, seconds: 3[\s\S]{0,120}waitForAutomationDelay\(3000, options\)/,
  );
});

test("ordinary resident single-sample validation requires an isolated one-cycle one-step runtime", async () => {
  const { resolveOrdinaryResidentSingleSampleValidation } = await import(
    `./inspect-garden-dryrun.mjs?ordinary-single-sample-validation=${Date.now()}`
  );
  const isolatedEnv = {
    ORDINARY_RESIDENT_ORDER_SINGLE_SAMPLE: "1",
    ACTION: "auto-loop",
    MAX_CYCLES: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "1",
    ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_GARDEN_LAND: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_WATER: "0",
    AUTO_SPEEDUP_FREE: "0",
  };

  assert.equal(
    resolveOrdinaryResidentSingleSampleValidation({}).enabled,
    false,
  );
  assert.deepEqual(
    resolveOrdinaryResidentSingleSampleValidation(isolatedEnv),
    {
      requested: true,
      enabled: true,
      reason: "single-sample-validation",
      bypassSpecialOrderDailyLimit: true,
    },
  );
  for (const unsafeOverride of [
    { MAX_CYCLES: "2" },
    { ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE: "2" },
    { AUTO_SUBMIT_SPECIAL_ORDERS: "1" },
    { AUTO_SUBMIT_CUSTOMER_ORDERS: "1" },
    { AUTO_SUBMIT_PALACE_ORDERS: "1" },
    { AUTO_SUBMIT_MAIN_TASKS: "1" },
    { AUTO_HANDLE_TEAM_ORDERS: "1" },
    { AUTO_HANDLE_GARDEN_LAND: "1" },
    { AUTO_HANDLE_FLOWER_RACK: "1" },
    { AUTO_HANDLE_PEARL: "1" },
    { AUTO_HANDLE_FML_LAND: "1" },
    { AUTO_HANDLE_FREE_WATER: "1" },
    { AUTO_HANDLE_WATERWHEEL: "1" },
    { AUTO_HANDLE_MATERIAL_SHOP: "1" },
    { AUTO_WATER: "1" },
    { AUTO_SPEEDUP_FREE: "1" },
  ]) {
    assert.throws(
      () => resolveOrdinaryResidentSingleSampleValidation({
        ...isolatedEnv,
        ...unsafeOverride,
      }),
      { code: "ORDINARY_RESIDENT_SINGLE_SAMPLE_UNSAFE" },
    );
  }
});

test("runtime pearl reserve settings normalize only numeric non-negative safe integers", async () => {
  const { normalizeProfileAutomationSettings } = await import(`./inspect-garden-dryrun.mjs?profile-settings-normalization=${Date.now()}`);
  for (const value of [undefined, "20", 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeProfileAutomationSettings({ pearlHireItemReserveCount: value }).pearlHireItemReserveCount, 100);
  }
  assert.equal(
    normalizeProfileAutomationSettings({ pearlHireItemReserveCount: Number.MAX_SAFE_INTEGER }).pearlHireItemReserveCount,
    Number.MAX_SAFE_INTEGER,
  );
});

test("runtime profile settings normalize the cyclic story auto submit switch", async () => {
  const { normalizeProfileAutomationSettings } = await import(
    `./inspect-garden-dryrun.mjs?cyclic-story-settings-normalize=${Date.now()}`
  );
  assert.equal(
    normalizeProfileAutomationSettings({}).autoSubmitCyclicStoryOrders,
    false,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ autoSubmitCyclicStoryOrders: true })
      .autoSubmitCyclicStoryOrders,
    true,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ autoSubmitCyclicStoryOrders: "true" })
      .autoSubmitCyclicStoryOrders,
    false,
  );
});

test("runtime profile settings normalize the cyclic story highest experience switch", async () => {
  const { normalizeProfileAutomationSettings } = await import(
    `./inspect-garden-dryrun.mjs?cyclic-story-highest-experience-settings-normalize=${Date.now()}`
  );
  assert.equal(
    normalizeProfileAutomationSettings({}).cyclicStoryOnlyHighestExperienceOrder,
    false,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ cyclicStoryOnlyHighestExperienceOrder: true })
      .cyclicStoryOnlyHighestExperienceOrder,
    true,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ cyclicStoryOnlyHighestExperienceOrder: "true" })
      .cyclicStoryOnlyHighestExperienceOrder,
    false,
  );
});

test("runtime cyclic story auto submit setting reads the persisted profile switch", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyclic-story-auto-submit-setting-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  try {
    const { getCyclicStoryAutoSubmitSetting } = await import(
      `./inspect-garden-dryrun.mjs?cyclic-story-setting-helper=${Date.now()}`
    );
    fs.writeFileSync(settingsPath, JSON.stringify({ autoSubmitCyclicStoryOrders: false }), "utf8");
    assert.deepEqual(getCyclicStoryAutoSubmitSetting(), {
      enabled: false,
      reason: "auto-submit-disabled-by-profile-setting",
      source: "profile-setting",
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ autoSubmitCyclicStoryOrders: true }), "utf8");
    assert.deepEqual(getCyclicStoryAutoSubmitSetting(), {
      enabled: true,
      reason: null,
      source: "profile-setting",
    });
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runtime cyclic story highest experience setting reads the persisted profile switch", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyclic-story-highest-experience-setting-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  try {
    const { getCyclicStoryOnlyHighestExperienceSetting } = await import(
      `./inspect-garden-dryrun.mjs?cyclic-story-highest-experience-setting-helper=${Date.now()}`
    );
    fs.writeFileSync(settingsPath, JSON.stringify({ cyclicStoryOnlyHighestExperienceOrder: false }), "utf8");
    assert.deepEqual(getCyclicStoryOnlyHighestExperienceSetting(), {
      enabled: false,
      reason: "highest-experience-only-disabled-by-profile-setting",
      source: "profile-setting",
    });
    fs.writeFileSync(settingsPath, JSON.stringify({ cyclicStoryOnlyHighestExperienceOrder: true }), "utf8");
    assert.deepEqual(getCyclicStoryOnlyHighestExperienceSetting(), {
      enabled: true,
      reason: null,
      source: "profile-setting",
    });
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runtime team-order protections reload the current profile settings without restart", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-order-runtime-settings-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  process.env.PROFILE_ID = "p1";
  process.env.AUTO_HANDLE_TEAM_ORDERS = "1";
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({
      teamOrderTriggerProtectionEnabled: true,
      teamOrderPaidRenewProtectionEnabled: true,
    }), "utf8");
    const {
      createTeamOrderSessionRuntime,
      normalizeProfileAutomationSettings,
    } = await import(`./inspect-garden-dryrun.mjs?team-order-runtime-settings=${Date.now()}`);
    assert.equal(
      normalizeProfileAutomationSettings({})
        .teamOrderTriggerProtectionEnabled,
      true,
    );
    assert.equal(
      normalizeProfileAutomationSettings({
        teamOrderTriggerProtectionEnabled: false,
      }).teamOrderTriggerProtectionEnabled,
      false,
    );
    assert.equal(
      normalizeProfileAutomationSettings({})
        .teamOrderPaidRenewProtectionEnabled,
      true,
    );
    assert.equal(
      normalizeProfileAutomationSettings({
        teamOrderPaidRenewProtectionEnabled: false,
      }).teamOrderPaidRenewProtectionEnabled,
      false,
    );
    const config = {
      durationSeconds: 50,
      maxOrderNum: 160,
      refreshPerSecond: 4,
      orders: new Map(Array.from({ length: 160 }, (_, index) => [
        index + 1,
        { orderNum: index + 1, flowerNum: 15 },
      ])),
    };
    const sync = {
      orderTeamTot: { orderTeam: { status: 0 } },
      $usrTot: { data: { id: "u1", bag: {} } },
    };
    const runtime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      teamOrderConfig: config,
    });

    assert.equal(
      runtime.capability(sync).teamOrderTriggerProtectionEnabled,
      true,
    );
    assert.equal(
      runtime.capability(sync).teamOrderPaidRenewProtectionEnabled,
      true,
    );
    assert.equal(runtime.getPaidRenewProtectionEnabled(), true);
    fs.writeFileSync(settingsPath, JSON.stringify({
      teamOrderTriggerProtectionEnabled: false,
      teamOrderPaidRenewProtectionEnabled: false,
    }), "utf8");
    assert.equal(
      runtime.capability(sync).teamOrderTriggerProtectionEnabled,
      false,
    );
    assert.equal(
      runtime.capability(sync).teamOrderPaidRenewProtectionEnabled,
      false,
    );
    assert.equal(runtime.getPaidRenewProtectionEnabled(), false);
    await runtime.flush();
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("ordinary resident preflight cannot bypass the current effective 49/99 gate", async () => {
  const { getOrdinaryResidentPreflightActions } = await import(
    `./inspect-garden-dryrun.mjs?ordinary-team-protection=${Date.now()}`
  );
  const orderStatus = {
    residentBoard: {
      completedCount: 49,
      teamOrderReady: false,
    },
    satin: { dailyLimitReached: true },
    decorate: { dailyLimitReached: true },
    ordinary: {
      orders: [{
        exists: true,
        boxId: 301,
        canFinish: true,
        isVideo: false,
        stateKnown: true,
        finishCnt: 0,
        cTime: "2026-06-16T00:00:00.000Z",
        cdTime: "2026-06-16T00:00:00.000Z",
        requirements: [[23001, 1]],
      }],
    },
  };
  const mainTaskStatus = {
    taskId: 12,
    canProgressResidentOrderMainTask: true,
    ordinaryResidentOrderGateReason: "resident-order-main-task",
    curValue: 1,
    targetValue: 2,
    remainingValue: 1,
  };

  assert.deepEqual(getOrdinaryResidentPreflightActions(
    orderStatus,
    mainTaskStatus,
    {
      ready: true,
      teamOrderTriggerProtectionEnabled: true,
    },
     { ordinaryAutoSubmitEnabled: true },
  ), []);
  assert.equal(getOrdinaryResidentPreflightActions(
    orderStatus,
    mainTaskStatus,
    {
      ready: true,
      teamOrderTriggerProtectionEnabled: false,
    },
     { ordinaryAutoSubmitEnabled: true },
  ).length, 0);
  assert.equal(getOrdinaryResidentPreflightActions(
    {
      ...orderStatus,
      residentBoard: {
        ...orderStatus.residentBoard,
        teamOrderReady: true,
      },
    },
    mainTaskStatus,
    {
      ready: true,
      teamOrderTriggerProtectionEnabled: false,
    },
     { ordinaryAutoSubmitEnabled: true },
  ).length, 1);
});

test("runtime profile settings normalize waterwheel parent and video bucket switches", async () => {
  const { normalizeProfileAutomationSettings } = await import(
    `./inspect-garden-dryrun.mjs?waterwheel-profile-settings-normalization=${Date.now()}`
  );

  assert.deepEqual(
    {
      autoReceiveWaterwheelBuckets: normalizeProfileAutomationSettings({}).autoReceiveWaterwheelBuckets,
      skipWaterwheelVideoBuckets: normalizeProfileAutomationSettings({}).skipWaterwheelVideoBuckets,
    },
    {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: false,
    },
  );
  assert.equal(
    normalizeProfileAutomationSettings({ autoReceiveWaterwheelBuckets: false }).autoReceiveWaterwheelBuckets,
    false,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ skipWaterwheelVideoBuckets: true }).skipWaterwheelVideoBuckets,
    true,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ autoReceiveWaterwheelBuckets: "false" }).autoReceiveWaterwheelBuckets,
    true,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ skipWaterwheelVideoBuckets: 1 }).skipWaterwheelVideoBuckets,
    false,
  );
});

test("waterwheel automation setting resolver distinguishes runtime and profile disable reasons", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "waterwheel-setting-resolver-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };

  try {
    process.env.PROFILE_SETTINGS_PATH = settingsPath;
    process.env.AUTO_HANDLE_WATERWHEEL = "0";
    fs.writeFileSync(settingsPath, JSON.stringify({
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: true,
    }), "utf8");
    const { getWaterwheelAutomationSetting } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-setting-resolver=${Date.now()}`
    );

    assert.deepEqual(getWaterwheelAutomationSetting(), {
      configuredAutoReceiveEnabled: true,
      effectiveAutoReceiveEnabled: false,
      configuredSkipVideoBucketsEnabled: true,
      effectiveSkipVideoBucketsEnabled: false,
      source: "profile-setting",
      reason: "runtime-disabled",
      reasonText: "AUTO_HANDLE_WATERWHEEL 已关闭水车自动处理",
    });

    process.env.AUTO_HANDLE_WATERWHEEL = "1";
    fs.writeFileSync(settingsPath, JSON.stringify({
      autoReceiveWaterwheelBuckets: false,
      skipWaterwheelVideoBuckets: true,
    }), "utf8");
    assert.deepEqual(getWaterwheelAutomationSetting(), {
      configuredAutoReceiveEnabled: false,
      effectiveAutoReceiveEnabled: false,
      configuredSkipVideoBucketsEnabled: true,
      effectiveSkipVideoBucketsEnabled: false,
      source: "profile-setting",
      reason: "profile-setting-disabled",
      reasonText: "账号已关闭领取水车水桶",
    });
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team-order checkpoint passes the live paid-renew protection reader into the runner", () => {
  const source = fs.readFileSync(
    new URL("./inspect-garden-dryrun.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /getPaidRenewProtectionEnabled:\s*\(\)\s*=>\s*\(\s*runtime\.getPaidRenewProtectionEnabled\?\.\(\)\s*\?\?\s*true\s*\)/,
  );
  assert.match(
    source,
    /getPaidRenewExperienceGuard:\s*\(latestSync\)\s*=>\s*\(\s*summarizeExperienceGuard\(latestSync\)\s*\)/,
  );
});

test("runtime experience guard settings preserve the account percentage contract", async () => {
  const { normalizeProfileAutomationSettings } = await import(
    `./inspect-garden-dryrun.mjs?experience-profile-settings-normalization=${Date.now()}`
  );

  assert.equal(
    normalizeProfileAutomationSettings({}).experienceGuardThresholdPercent,
    0.5,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ experienceGuardThresholdPercent: 0.01 })
      .experienceGuardThresholdPercent,
    0.01,
  );
  assert.equal(
    normalizeProfileAutomationSettings({ experienceGuardThresholdPercent: 0 })
      .experienceGuardThresholdPercent,
    0,
  );
  for (const value of ["0.50", 0.001, 1.234, Number.POSITIVE_INFINITY]) {
    assert.equal(
      normalizeProfileAutomationSettings({ experienceGuardThresholdPercent: value })
        .experienceGuardThresholdPercent,
      0.5,
      String(value),
    );
  }
});

test("runtime customer order reward release setting preserves legacy defaults and fails closed on invalid data", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "customer-order-release-setting-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  try {
    const { getCustomerOrderFlowerCurrencyRewardReleaseSetting } = await import(
      `./inspect-garden-dryrun.mjs?customer-order-release-setting=${Date.now()}`
    );
    delete process.env.PROFILE_SETTINGS_PATH;
    assert.deepEqual(getCustomerOrderFlowerCurrencyRewardReleaseSetting(), {
      mask: 4,
      rewards: [3],
      source: "profile-default",
      reason: null,
    });
    process.env.PROFILE_SETTINGS_PATH = settingsPath;
    fs.writeFileSync(settingsPath, JSON.stringify({}), "utf8");
    assert.deepEqual(getCustomerOrderFlowerCurrencyRewardReleaseSetting(), {
      mask: 4,
      rewards: [3],
      source: "profile-setting",
      reason: null,
    });
    fs.writeFileSync(settingsPath, JSON.stringify({
      customerOrderFlowerCurrencyRewardReleaseMask: 5,
    }), "utf8");
    assert.deepEqual(getCustomerOrderFlowerCurrencyRewardReleaseSetting(), {
      mask: 5,
      rewards: [1, 3],
      source: "profile-setting",
      reason: null,
    });
    fs.writeFileSync(settingsPath, JSON.stringify({
      customerOrderFlowerCurrencyRewardReleaseMask: 8,
    }), "utf8");
    assert.deepEqual(getCustomerOrderFlowerCurrencyRewardReleaseSetting(), {
      mask: 0,
      rewards: [],
      source: "profile-setting",
      reason: "invalid-profile-setting-fail-closed",
    });
    fs.writeFileSync(settingsPath, "{invalid json", "utf8");
    assert.deepEqual(getCustomerOrderFlowerCurrencyRewardReleaseSetting(), {
      mask: 0,
      rewards: [],
      source: "profile-setting",
      reason: "profile-setting-read-failed-fail-closed",
    });
    fs.rmSync(settingsPath);
    assert.deepEqual(getCustomerOrderFlowerCurrencyRewardReleaseSetting(), {
      mask: 0,
      rewards: [],
      source: "profile-setting",
      reason: "profile-setting-read-failed-fail-closed",
    });
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runtime material shop refresh settings load per profile and keep the hard cost ceiling", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "material-shop-runtime-settings-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  delete process.env.AUTO_REFRESH_MATERIAL_SHOP_BEFORE_MIDNIGHT;
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({
      materialShopMidnightRefreshEnabled: true,
      materialShopRefreshWindowStart: "23:40",
      materialShopRefreshMaxCostYuanbao: 8,
    }));
    const { getMaterialShopMidnightRefreshOptions } = await import(
      `./inspect-garden-dryrun.mjs?material-shop-runtime-settings=${Date.now()}`
    );

    assert.deepEqual(getMaterialShopMidnightRefreshOptions({}), {
      enabled: true,
      windowStart: "23:40",
      windowEnd: "24:00",
      maxCostYuanbao: 8,
    });
    assert.equal(getMaterialShopMidnightRefreshOptions({
      MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO: "100",
    }).maxCostYuanbao, 16);
    assert.equal(getMaterialShopMidnightRefreshOptions({
      AUTO_REFRESH_MATERIAL_SHOP_BEFORE_MIDNIGHT: "0",
    }).enabled, false);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team-order runtime applies persisted account history times two at the 49/99 trigger", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-order-experience-runtime-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const historyPath = path.join(outDir, "team-order-experience-history.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  process.env.PROFILE_ID = "p1";
  process.env.AUTO_HANDLE_TEAM_ORDERS = "1";
  fs.writeFileSync(settingsPath, JSON.stringify({
    teamOrderTriggerProtectionEnabled: false,
    experienceGuardThresholdPercent: 1.25,
  }), "utf8");

  const teamOrderConfig = {
    durationSeconds: 50,
    maxOrderNum: 160,
    refreshPerSecond: 4,
    orders: new Map(Array.from({ length: 160 }, (_, index) => [
      index + 1,
      { orderNum: index + 1, flowerNum: 15 },
    ])),
  };
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map([
      [23001, { id: 23001, experience: 500 }],
    ]),
    flowerLevelExact: new Map(),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const sync = {
    $usrTot: {
      data: {
        id: "u1",
        lvl: 40,
        lvlExp: 100,
        nextExp: 10_500,
        bag: { 23001: 1 },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 1 },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          8: {
            boxId: 8,
            flowers: [[23001, 1]],
          },
        },
      },
    },
    orderTeamTot: {
      orderTeam: { status: 0 },
    },
  };

  try {
    const {
      createTeamOrderSessionRuntime,
    } = await import(`./inspect-garden-dryrun.mjs?team-order-experience-runtime=${Date.now()}`);
    const {
      saveTeamOrderExperienceHistory,
    } = await import("./team-order-experience-history.mjs");

    const coldRuntime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig,
      experienceConfig,
      teamOrderExperienceHistoryPath: historyPath,
    });
    const coldCapability = coldRuntime.capability(sync);
    assert.equal(coldCapability.requiresExperienceTriggerDecision, false);
    assert.equal(coldCapability.evaluateTrigger({
      iface: "gs.orderFlower.finishOrder",
      args: { boxId: 8 },
    }).coldStartBypass, true);
    await coldRuntime.flush();

    saveTeamOrderExperienceHistory(historyPath, {
      version: 1,
      accounts: {
        u1: {
          accountHistoricalMaxFinalExp: 5_000,
        },
      },
    });
    const historicalRuntime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig,
      experienceConfig,
      teamOrderExperienceHistoryPath: historyPath,
    });
    const capability = historicalRuntime.capability(sync);
    const decision = capability.evaluateTrigger({
      iface: "gs.orderFlower.finishOrder",
      args: { boxId: 8 },
    });

    assert.equal(capability.requiresExperienceTriggerDecision, true);
    assert.equal(capability.accountHistoricalMaxTeamExp, 5_000);
    assert.equal(capability.thresholdPercent, 1.25);
    assert.equal(capability.minimumRemainingExp, 132);
    assert.equal(decision.triggeringResidentOrderMaxExp, 500);
    assert.equal(decision.minimumRemainingExp, 132);
    assert.equal(decision.minimumRemainingExp, capability.minimumRemainingExp);
    assert.equal(decision.teamOrderGuardExp, 10_000);
    assert.equal(decision.requiredExperienceSpace, 10_632);
    assert.equal(decision.blocked, true);
    assert.equal(decision.forceTriggerProtectionEnabled, true);
    await historicalRuntime.flush();

    const allowedSync = {
      ...sync,
      $usrTot: {
        ...sync.$usrTot,
        data: {
          ...sync.$usrTot.data,
          lvlExp: 100,
          nextExp: 20_000,
        },
      },
    };
    const reservedRuntime = createTeamOrderSessionRuntime(allowedSync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig,
      experienceConfig,
      teamOrderExperienceHistoryPath: historyPath,
    });
    const triggerAction = {
      iface: "gs.orderFlower.finishOrder",
      args: { boxId: 8 },
    };
    const allowedDecision =
      reservedRuntime.capability(allowedSync).evaluateTrigger(triggerAction);
    const changedSync = {
      ...allowedSync,
      $usrTot: {
        ...allowedSync.$usrTot,
        data: {
          ...allowedSync.$usrTot.data,
          lvlExp: 19_900,
        },
      },
    };
    const reusedDecision =
      reservedRuntime.capability(changedSync).evaluateTrigger(triggerAction);

    assert.equal(allowedDecision.blocked, false);
    assert.equal(reusedDecision.blocked, false);
    assert.equal(reusedDecision.teamOrderReservationId, allowedDecision.teamOrderReservationId);
    assert.equal(reusedDecision.triggerDecisionReused, true);

    const cancelled = reservedRuntime.cancelTriggerReservation({
      ...triggerAction,
      teamTriggerDecision: allowedDecision,
    }, "resident-order-request-failed");
    assert.equal(cancelled.teamOrderReservationId, allowedDecision.teamOrderReservationId);
    assert.equal(cancelled.reason, "resident-order-request-failed");
    assert.equal(
      reservedRuntime.capability(changedSync).evaluateTrigger(triggerAction).blocked,
      true,
    );

    const secondAllowedDecision =
      reservedRuntime.capability(allowedSync).evaluateTrigger(triggerAction);
    assert.equal(secondAllowedDecision.blocked, false);
    assert.equal(reservedRuntime.recordCompletedExperience(
      allowedSync,
      allowedSync,
      {
        handled: true,
        finalReason: "server-ended",
      },
    ), null);
    assert.equal(reservedRuntime.capability(allowedSync).teamOrderReservationId, null);
    assert.equal(
      reservedRuntime.capability(changedSync).evaluateTrigger(triggerAction).blocked,
      true,
    );
    await reservedRuntime.flush();
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team-order runtime applies an injected custom guard multiplier", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-order-guard-multiplier-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const historyPath = path.join(outDir, "team-order-experience-history.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  process.env.PROFILE_ID = "p1";
  process.env.AUTO_HANDLE_TEAM_ORDERS = "1";
  fs.writeFileSync(settingsPath, JSON.stringify({
    teamOrderTriggerProtectionEnabled: false,
    experienceGuardThresholdPercent: 1.25,
  }), "utf8");

  const teamOrderConfig = {
    durationSeconds: 50,
    maxOrderNum: 160,
    refreshPerSecond: 4,
    orders: new Map(Array.from({ length: 160 }, (_, index) => [
      index + 1,
      { orderNum: index + 1, flowerNum: 15 },
    ])),
  };
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map([
      [23001, { id: 23001, experience: 500 }],
    ]),
    flowerLevelExact: new Map(),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const sync = {
    $usrTot: {
      data: {
        id: "u1",
        lvl: 40,
        lvlExp: 100,
        nextExp: 10_500,
        bag: { 23001: 1 },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 1 },
      },
    },
    orderFlowerTot: {
      orderFlower: {
        orderMap: {
          8: {
            boxId: 8,
            flowers: [[23001, 1]],
          },
        },
      },
    },
    orderTeamTot: {
      orderTeam: { status: 0 },
    },
  };

  try {
    const {
      createTeamOrderSessionRuntime,
    } = await import(`./inspect-garden-dryrun.mjs?team-order-guard-multiplier=${Date.now()}`);
    const {
      saveTeamOrderExperienceHistory,
    } = await import("./team-order-experience-history.mjs");

    saveTeamOrderExperienceHistory(historyPath, {
      version: 1,
      accounts: {
        u1: {
          accountHistoricalMaxFinalExp: 5_000,
        },
      },
    });
    const runtime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig,
      experienceConfig,
      teamOrderExperienceHistoryPath: historyPath,
      getTeamOrderGuardMultiplier: () => 3,
    });
    const capability = runtime.capability(sync);
    const decision = capability.evaluateTrigger({
      iface: "gs.orderFlower.finishOrder",
      args: { boxId: 8 },
    });

    assert.equal(capability.teamOrderGuardMultiplier, 3);
    assert.equal(capability.teamOrderGuardExp, 15_000);
    assert.equal(capability.accountHistoricalMaxTeamExp, 5_000);
    assert.equal(decision.teamOrderGuardExp, 15_000);
    assert.equal(decision.requiredExperienceSpace, 15_632);
    await runtime.flush();

    const defaultRuntime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig,
      experienceConfig,
      teamOrderExperienceHistoryPath: historyPath,
    });
    assert.equal(defaultRuntime.capability(sync).teamOrderGuardMultiplier, 2);
    await defaultRuntime.flush();
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team-order runtime records only a completed final experience delta", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-order-experience-record-"));
  const historyPath = path.join(outDir, "team-order-experience-history.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_ID = "p1";
  process.env.AUTO_HANDLE_TEAM_ORDERS = "1";
  const sync = {
    $usrTot: {
      data: {
        id: "u1",
        lvl: 40,
        lvlExp: 100,
        nextExp: 100_000,
        bag: {},
      },
    },
    orderTeamTot: {
      orderTeam: { status: 3 },
    },
  };
  const completed = {
    ...sync,
    $usrTot: {
      data: {
        ...sync.$usrTot.data,
        lvlExp: 4_100,
      },
    },
    orderTeamTot: {
      orderTeam: { status: 0 },
    },
  };

  try {
    const {
      createTeamOrderSessionRuntime,
    } = await import(`./inspect-garden-dryrun.mjs?team-order-experience-record=${Date.now()}`);
    const {
      loadTeamOrderExperienceHistory,
    } = await import("./team-order-experience-history.mjs");
    const runtime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map(),
      },
      experienceConfig: {
        compatible: true,
        reasons: [],
      },
      teamOrderExperienceHistoryPath: historyPath,
    });

    runtime.recordCompletedExperience(sync, completed, {
      handled: true,
      finalReason: "server-ended",
    });
    runtime.recordCompletedExperience(completed, {
      ...completed,
      $usrTot: {
        data: {
          ...completed.$usrTot.data,
          lvlExp: 9_100,
        },
      },
    }, {
      handled: true,
      finalReason: "settlement-pending",
    });

    const history = loadTeamOrderExperienceHistory(historyPath);
    assert.equal(history.accounts.u1.accountHistoricalMaxFinalExp, 4_000);
    assert.equal(history.accounts.u1.sampleCount, 1);
    await runtime.flush();
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team-order runtime records recvRwd item 2 delta even when level-up resets lvlExp", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-order-experience-level-up-"));
  const historyPath = path.join(outDir, "team-order-experience-history.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_ID = "p1";
  process.env.AUTO_HANDLE_TEAM_ORDERS = "1";
  const sync = {
    $usrTot: {
      data: {
        id: "u1",
        lvl: 49,
        lvlExp: 9_995,
        nextExp: 10_000,
        bag: {},
      },
    },
    orderTeamTot: {
      orderTeam: { status: 3 },
    },
  };
  const levelledSync = {
    ...sync,
    $usrTot: {
      data: {
        ...sync.$usrTot.data,
        lvl: 50,
        lvlExp: 7_995,
        nextExp: 20_000,
      },
    },
    orderTeamTot: {
      orderTeam: { status: 0 },
    },
  };

  try {
    const {
      createTeamOrderSessionRuntime,
    } = await import(`./inspect-garden-dryrun.mjs?team-order-level-up-record=${Date.now()}`);
    const {
      loadTeamOrderExperienceHistory,
    } = await import("./team-order-experience-history.mjs");
    const runtime = createTeamOrderSessionRuntime(sync, {
      profileId: "p1",
      statusDir: outDir,
      teamOrderConfig: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map(),
      },
      experienceConfig: {
        compatible: true,
        reasons: [],
      },
      teamOrderExperienceHistoryPath: historyPath,
    });
    runtime.bind({
      async request(iface) {
        assert.equal(iface, "gs.orderTeam.recvRwd");
        return raw({
          $usrTot: {
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 8_000,
              },
            },
          },
          orderTeamTot: {
            orderTeam: { status: 0 },
          },
        });
      },
    }, "token");

    const result = await runtime.runner.handle(sync, {
      trigger: "settlement",
      config: runtime.config,
    });
    runtime.recordCompletedExperience(sync, levelledSync, result);

    const history = loadTeamOrderExperienceHistory(historyPath);
    assert.equal(history.accounts.u1.accountHistoricalMaxFinalExp, 8_000);
    assert.equal(history.accounts.u1.sampleCount, 1);
    await runtime.flush();
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

function raw(value) {
  return {
    v: value,
  };
}

function addDefaultExperienceToLazySyncResult(result) {
  const value = result?.v;
  if (!value || typeof value !== "object") return result;
  const usrTot = value.$usrTot || {};
  const dataKey = usrTot.data || !usrTot.usr ? "data" : "usr";
  const data = usrTot[dataKey] || {};
  const hasExperience = data.lvl != null
    || data.level != null
    || data.lvlExp != null
    || data.nextExp != null
    || data.requiredExp != null;
  if (hasExperience) return result;
  return {
    ...result,
    v: {
      ...value,
      $usrTot: {
        ...usrTot,
        [dataKey]: {
          lvl: 40,
          lvlExp: 1000000,
          nextExp: 10000000,
          ...data,
        },
      },
    },
  };
}

function readWaterDropFromLazySyncResult(result) {
  const value = result?.v;
  const usrTot = value?.$usrTot || {};
  const data = usrTot.data || {};
  const usr = usrTot.usr || {};
  let baseCount = null;
  for (const map of [data.bag, data.itemMap, usr.bag, usr.itemMap, usrTot.bag, usrTot.itemMap, usrTot.oi?.bd, value?.oi?.bd]) {
    if (!map || typeof map !== "object") continue;
    const raw = Object.prototype.hasOwnProperty.call(map, ITEM_IDS.WATER_DROP)
      ? map[ITEM_IDS.WATER_DROP]
      : map[String(ITEM_IDS.WATER_DROP)];
    const count = Number(raw);
    if (Number.isFinite(count)) {
      baseCount = Math.max(0, Math.floor(count));
      break;
    }
  }
  if (baseCount == null) return null;

  let delta = 0;
  const deltaMaps = [
    usrTot.itemAddChg?.itemMap,
    usrTot.itemAddChg?.items,
    usrTot.itemAddChg,
    usrTot.oi?.bi,
    usrTot.oi?.bo,
    value?.itemAddChg?.itemMap,
    value?.itemAddChg,
    value?.oi?.bi,
    value?.oi?.bo,
  ];
  for (const map of deltaMaps) {
    if (!map || typeof map !== "object") continue;
    const raw = Object.prototype.hasOwnProperty.call(map, ITEM_IDS.WATER_DROP)
      ? map[ITEM_IDS.WATER_DROP]
      : map[String(ITEM_IDS.WATER_DROP)];
    const valueDelta = Number(raw);
    if (Number.isFinite(valueDelta)) delta += valueDelta;
  }
  return Math.max(0, Math.floor(baseCount + delta));
}

function readWaterDropDeltaFromResult(result) {
  const value = result?.v;
  const usrTot = value?.$usrTot || {};
  let delta = 0;
  let found = false;
  const deltaMaps = [
    usrTot.itemAddChg?.itemMap,
    usrTot.itemAddChg?.items,
    usrTot.itemAddChg,
    usrTot.oi?.bi,
    usrTot.oi?.bo,
    value?.itemAddChg?.itemMap,
    value?.itemAddChg,
    value?.oi?.bi,
    value?.oi?.bo,
  ];
  for (const map of deltaMaps) {
    if (!map || typeof map !== "object") continue;
    const raw = Object.prototype.hasOwnProperty.call(map, ITEM_IDS.WATER_DROP)
      ? map[ITEM_IDS.WATER_DROP]
      : map[String(ITEM_IDS.WATER_DROP)];
    const valueDelta = Number(raw);
    if (Number.isFinite(valueDelta)) {
      delta += valueDelta;
      found = true;
    }
  }
  return found ? delta : null;
}

function addDefaultWaterToLazySyncResult(result, defaultWaterDropCount = 99) {
  const value = result?.v;
  if (!value || typeof value !== "object") return result;
  const usrTot = value.$usrTot || {};
  const dataKey = usrTot.data || !usrTot.usr ? "data" : "usr";
  const data = usrTot[dataKey] || {};
  const bag = data.bag || data.itemMap || usrTot.bag || usrTot.itemMap || {};
  const hasWater = Object.prototype.hasOwnProperty.call(bag, ITEM_IDS.WATER_DROP)
    || Object.prototype.hasOwnProperty.call(bag, String(ITEM_IDS.WATER_DROP));
  if (hasWater) return result;
  return {
    ...result,
    v: {
      ...value,
      $usrTot: {
        ...usrTot,
        [dataKey]: {
          ...data,
          bag: {
            ...bag,
            [ITEM_IDS.WATER_DROP]: Math.max(0, Math.floor(Number(defaultWaterDropCount) || 0)),
          },
        },
      },
    },
  };
}

function withDefaultExperienceLazySync(ws, options = {}) {
  const allowUnknownExperience = options.allowUnknownExperience === true || ws.allowUnknownExperience === true;
  const allowUnknownWater = options.allowUnknownWater === true || ws.allowUnknownWater === true;
  let lastWaterDropCount = Number.isFinite(Number(options.defaultWaterDropCount))
    ? Math.max(0, Math.floor(Number(options.defaultWaterDropCount)))
    : null;
  return {
    ...ws,
    async request(iface, args, token) {
      try {
        const result = await ws.request(iface, args, token);
        const observedWaterDropCount = readWaterDropFromLazySyncResult(result);
        if (observedWaterDropCount != null) lastWaterDropCount = observedWaterDropCount;
        if (observedWaterDropCount == null && iface !== "gs.usr.lazySync" && lastWaterDropCount != null) {
          const observedWaterDropDelta = readWaterDropDeltaFromResult(result);
          if (observedWaterDropDelta != null) {
            lastWaterDropCount = Math.max(0, Math.floor(lastWaterDropCount + observedWaterDropDelta));
          }
        }
        if (iface === "gs.usr.lazySync" && !allowUnknownExperience) {
          const withExperience = addDefaultExperienceToLazySyncResult(result);
          return allowUnknownWater ? withExperience : addDefaultWaterToLazySyncResult(withExperience, lastWaterDropCount ?? 99);
        }
        return result;
      } catch (err) {
        if (iface === "gs.usr.lazySync" && String(err?.message || "").includes("unexpected iface gs.usr.lazySync")) {
          const result = raw({});
          if (allowUnknownExperience) return result;
          const withExperience = addDefaultExperienceToLazySyncResult(result);
          return allowUnknownWater ? withExperience : addDefaultWaterToLazySyncResult(withExperience, lastWaterDropCount ?? 99);
        }
        throw err;
      }
    },
  };
}

function ifacesWithoutLazySync(requestLog) {
  return requestLog
    .map((item) => item.iface)
    .filter((iface) => iface !== "gs.usr.lazySync");
}

function makeSync(landMap, flowerCount = 0) {
  return {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 1000000,
        nextExp: 10000000,
        bag: {
          7: 99,
          23001: flowerCount,
        },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: {
          flowerId: 23001,
          lvl: 2,
          cTime: "2026-06-16T00:00:00.000Z",
        },
      },
    },
    rchgTot: {
      cardMap: {},
    },
    usrLandTot: {
      usrLand: {
        landMap,
      },
    },
  };
}

function makeTrustedTimeAuthority(nowMs = Date.now()) {
  return {
    version: 1,
    lastAcceptedSample: {
      serverMs: nowMs,
      correctedServerMs: nowMs,
      requestStartedAtMs: nowMs,
      responseAtMs: nowMs,
      rttMs: 0,
      serverOffsetMs: 0,
      acceptedAtMs: nowMs,
    },
    sampleMaxAgeMs: 120_000,
  };
}

function customerNpcConfigForTest(npcIds, sourcePath = "fixture:c_orderCustomerNpc") {
  return {
    sourcePath,
    npcIds,
    npcs: Object.fromEntries(npcIds.map((npcId) => [npcId, { id: npcId, maintaskId: 0 }])),
    npcMaxDay: 350,
  };
}

function assignCycleEnv(values) {
  const statusDir = values.STATUS_DOC_DIR || process.env.STATUS_DOC_DIR;
  const bucketStatePath = values.WATERWHEEL_BUCKET_STATE_PATH
    || (statusDir ? path.join(statusDir, "waterwheel-bucket-state.json") : null);
  Object.assign(process.env, {
    PROFILE_ID: "cycle-test-account",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    ...(bucketStatePath ? { WATERWHEEL_BUCKET_STATE_PATH: bucketStatePath } : {}),
    ...values,
  });
  if (values.AUTO_HANDLE_WATERWHEEL === "1" && bucketStatePath) {
    const state = {
      ...createWaterwheelBucketState({
        profileId: process.env.PROFILE_ID || "cycle-test-account",
        nowMs: Date.now(),
        config: { bucketCreateCd: 30, bucketExistMax: 8, bucketGetMax: 60 },
      }),
      storedBucketCount: 1,
      nextGenerationAtMs: null,
    };
    saveWaterwheelBucketState({ statePath: bucketStatePath, state });
  }
}

function makeLandIds(startLandId, count) {
  return Array.from({ length: count }, (_, index) => startLandId + index);
}

function makeLandEntries(startLandId, count, value) {
  return makeLandIds(startLandId, count).map((landId) => [landId, { ...value }]);
}

function getResidentOrderMainTaskForTest() {
  const config = loadMainTaskConfig();
  const task = [...config.tasks.values()]
    .find((row) => RESIDENT_ORDER_MAIN_TASK_TYPES.has(Number(row.type)) && Number(row.value) >= 3);
  assert.ok(task, "expected bundled c_task_main to contain a resident order task");
  return task;
}

function getLevelUpMainTaskForTest() {
  const config = loadMainTaskConfig();
  const task = [...config.tasks.values()]
    .find((row) => Number(row.type) === 2 && Number(row.value) >= 4);
  assert.ok(task, "expected bundled c_task_main to contain a level-up task");
  return task;
}

function getCyclicNoteTasksForTest(count = 2) {
  const config = loadCyclicNoteConfig();
  const tasks = [...config.actCyclicNote.values()]
    .map((row) => ({
      id: Number(row.id),
      value: Number(row.value),
      type: Number(row.type),
    }))
    .filter((row) => Number.isFinite(row.id) && Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => a.id - b.id);
  assert.ok(tasks.length >= count, `expected bundled c_actCyclicNote to contain at least ${count} tasks`);
  return tasks.slice(0, count);
}

function makeCyclicNoteSync({
  batchId = 88001,
  includeBatchId = true,
  mapKey = null,
  phase = 2,
  taskList = [],
  progress = {},
  recvMap = {},
  score = 7,
  bms = Date.now() - 60_000,
  ems = Date.now() + 60_000,
  durationBefore = 0,
  durationAfter = 0,
  timeAuthority = makeTrustedTimeAuthority(),
} = {}) {
  const act = {
    tmpId: CYCLIC_NOTE_ACTIVITY_TYPE,
    tmpType: CYCLIC_NOTE_ACTIVITY_TYPE,
    phase,
    bms,
    ems,
    duration_before: durationBefore,
    duration_after: durationAfter,
    score,
    ext: {
      cyclicNote: {
        taskList,
      },
    },
  };
  if (includeBatchId) {
    act.batchId = batchId;
  }
  return {
    actTot: {
      map: {
        [mapKey ?? (includeBatchId ? batchId : "cyclic-note-test")]: act,
      },
      taskRcdMap: {
        [`${batchId}|0`]: { progress, recvMap },
      },
    },
    $timeAuthority: timeAuthority,
  };
}

const FORBIDDEN_CYCLIC_NOTE_ACTIONS = new Set([
  "reRandomTask",
  "unlockTaskSlot",
  "directRecvTaskRwd",
  "giftBuy",
  "recv",
  "resetGiftCd",
]);

function makeCyclicNoteRequestFixture({
  refreshSync,
  enterResponses = [],
  recvTaskRwdResponses = [],
  lazySyncResponses = [],
}) {
  const requestLog = [];
  const enterQueue = [...enterResponses];
  const recvQueue = [...recvTaskRwdResponses];
  const lazySyncQueue = [...lazySyncResponses];

  const takeResponse = (queue, fallback, args) => {
    if (!queue.length) return fallback;
    const next = queue.shift();
    if (typeof next === "function") return next(args);
    return next;
  };

  return {
    requestLog,
    ws: {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface.startsWith("gs.actCyclicNote.")) {
          const actionName = iface.slice("gs.actCyclicNote.".length);
          assert.equal(
            FORBIDDEN_CYCLIC_NOTE_ACTIONS.has(actionName),
            false,
            `forbidden cyclic note iface ${iface}`,
          );
        }
        if (iface === "gs.usrLand.refresh") return raw(refreshSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.actCyclicNote.enter") {
          return raw(takeResponse(enterQueue, refreshSync, args));
        }
        if (iface === "gs.actCyclicNote.recvTaskRwd") {
          const response = takeResponse(recvQueue, {}, args);
          if (response instanceof Error) throw response;
          return raw(response);
        }
        if (iface === "gs.usr.lazySync") {
          return raw(takeResponse(lazySyncQueue, {}, args));
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    },
  };
}

function makeCyclicStorySync({
  batchId = 99001,
  includeBatchId = true,
  phase = 2,
  expOrderNum = 12,
  orderInfo = {},
  score = 21,
} = {}) {
  const act = {
    tmpId: CYCLIC_STORY_ACTIVITY_TYPE,
    tmpType: CYCLIC_STORY_ACTIVITY_TYPE,
    phase,
    score,
    ext: {
      cyclicStory: {
        expOrderNum,
        orderInfo,
      },
    },
  };
  if (includeBatchId) act.batchId = batchId;
  return {
    actTot: {
      map: {
        [batchId]: act,
      },
    },
  };
}

const FORBIDDEN_CYCLIC_STORY_ACTIONS = new Set([
  "giftBuy",
  "recv",
  "resetGiftCd",
  "reRandomOrder",
  "removeOrderCd",
]);

function makeCyclicStoryRequestFixture({
  refreshSync,
  enterResponses = [],
  recvOrderRwdResponses = [],
  lazySyncResponses = [],
}) {
  const requestLog = [];
  const enterQueue = [...enterResponses];
  const recvQueue = [...recvOrderRwdResponses];
  const lazySyncQueue = [...lazySyncResponses];
  const takeResponse = (queue, fallback, args) => {
    if (!queue.length) return fallback;
    const next = queue.shift();
    return typeof next === "function" ? next(args) : next;
  };

  return {
    requestLog,
    ws: {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface.startsWith("gs.actCyclicStory.")) {
          const actionName = iface.slice("gs.actCyclicStory.".length);
          assert.equal(
            FORBIDDEN_CYCLIC_STORY_ACTIONS.has(actionName),
            false,
            `forbidden cyclic story iface ${iface}`,
          );
        }
        if (iface === "gs.usrLand.refresh") return raw(refreshSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.actCyclicStory.enter") {
          return raw(takeResponse(enterQueue, refreshSync, args));
        }
        if (iface === "gs.actCyclicStory.recvOrderRwd") {
          const response = takeResponse(recvQueue, {}, args);
          if (response instanceof Error) throw response;
          return raw(response);
        }
        if (iface === "gs.usr.lazySync") {
          return raw(takeResponse(lazySyncQueue, {}, args));
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    },
  };
}

test("summarizeAccountLevel reads current exp from usrTot lvlExp", async () => {
  const { summarizeAccountLevel } = await import(`./inspect-garden-dryrun.mjs?account-level-test=${Date.now()}`);
  const summary = summarizeAccountLevel({
    $usrTot: {
      data: {
        lvl: 39,
        lvlExp: 123456,
      },
    },
  });
  assert.equal(summary.level, 39);
  assert.equal(summary.currentExp, 123456);
  assert.ok(Number.isFinite(summary.requiredExp), "expected next level exp from c_lvl");
  assert.equal(summary.progressText.startsWith("12,3456/"), true);
  assert.equal(summary.progressText.includes("%"), true);
});

test("summarizeExperienceGuard uses a dynamic 0.5 percent threshold", async () => {
  const { summarizeExperienceGuard } = await import(`./inspect-garden-dryrun.mjs?experience-guard-percent-test=${Date.now()}`);

  const guard = summarizeExperienceGuard({
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 9900000,
        nextExp: 10000000,
      },
    },
  });

  assert.equal(guard.known, true);
  assert.equal(guard.blocked, false);
  assert.equal(guard.remainingExp, 100000);
  assert.equal(guard.progressPercent, 99);
  assert.equal(guard.thresholdPercent, 0.5);
  assert.equal(guard.thresholdRemainingExp, 50_000);
  assert.equal(guard.protectionLimitExp, 9_950_000);
  assert.equal(guard.remainingToProtectionExp, 50_000);
  assert.equal(guard.thresholdReached, false);
  assert.equal(guard.reason, "action-level-check");
});

test("summarizeExperienceGuard blocks at the actual 0.5 percent protection line", async () => {
  const { summarizeExperienceGuard } = await import(`./inspect-garden-dryrun.mjs?experience-guard-remaining-test=${Date.now()}`);

  const blocked = summarizeExperienceGuard({
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 99_500,
        nextExp: 100000,
      },
    },
  });
  assert.equal(blocked.thresholdRemainingExp, 500);
  assert.equal(blocked.thresholdPercent, 0.5);
  assert.equal(blocked.progressPercent, 99.5);
  assert.equal(blocked.remainingExp, 500);
  assert.equal(blocked.remainingToProtectionExp, 0);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.thresholdReached, true);
  assert.equal(blocked.reason, "experience-protection-boundary");

  const allowed = summarizeExperienceGuard({
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 99_499,
        nextExp: 100000,
      },
    },
  });
  assert.equal(allowed.remainingExp, 501);
  assert.equal(allowed.remainingToProtectionExp, 1);
  assert.equal(allowed.blocked, false);
  assert.equal(allowed.thresholdReached, false);
});

test("summarizeExperienceGuard uses the configured account percentage for its line and distance", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "experience-guard-summary-settings-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  fs.writeFileSync(settingsPath, JSON.stringify({
    experienceGuardThresholdPercent: 1.25,
  }), "utf8");

  try {
    const { summarizeExperienceGuard } = await import(
      `./inspect-garden-dryrun.mjs?experience-guard-custom-percent-summary=${Date.now()}`
    );
    const guard = summarizeExperienceGuard({
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 98_000,
          nextExp: 100_000,
        },
      },
    });

    assert.equal(guard.thresholdPercent, 1.25);
    assert.equal(guard.thresholdRemainingExp, 1_250);
    assert.equal(guard.protectionLimitExp, 98_750);
    assert.equal(guard.remainingExp, 2_000);
    assert.equal(guard.remainingToProtectionExp, 750);
    assert.equal(guard.blocked, false);
    assert.match(guard.reasonText, /1\.25%门槛/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("summarizeExperienceGuard disables the line and shows the no-threshold copy at 0 percent", async () => {
  const { summarizeExperienceGuard } = await import(`./inspect-garden-dryrun.mjs?experience-guard-zero-summary=${Date.now()}`);

  const guard = summarizeExperienceGuard({
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 999_500,
        nextExp: 1_000_000,
      },
    },
  }, { thresholdPercent: 0 });

  assert.equal(guard.thresholdPercent, 0);
  assert.equal(guard.thresholdRemainingExp, 0);
  assert.equal(guard.protectionLimitExp, 1_000_000);
  assert.equal(guard.remainingExp, 500);
  assert.equal(guard.remainingToProtectionExp, 500);
  assert.equal(guard.thresholdReached, false);
  assert.equal(guard.blocked, false);
  assert.equal(guard.reason, "action-level-check");
  assert.match(guard.reasonText, /不设门槛/);
  assert.doesNotMatch(guard.reasonText, /0\.00%/);
});

test("experience action guard hot-loads the configured account percentage without restart", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "experience-action-guard-settings-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  process.env.PROFILE_SETTINGS_PATH = settingsPath;
  fs.writeFileSync(settingsPath, JSON.stringify({
    experienceGuardThresholdPercent: 0.01,
  }), "utf8");

  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 87 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 900,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
            1002: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  let harvestRequests = 0;
  const ws = {
    async request(iface) {
      if (iface === "gs.usr.lazySync") return raw({});
      if (iface === "gs.usrLand.harvest") {
        harvestRequests += 1;
        return raw({});
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };

  try {
    const { createExperienceGuardedWs } = await import(
      `./inspect-garden-dryrun.mjs?experience-action-guard-hot-load=${Date.now()}`
    );
    const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
      experienceConfig,
      cycle: 1,
    });

    await guarded.request("gs.usrLand.harvest", { landId: 1001 });
    fs.writeFileSync(settingsPath, JSON.stringify({
      experienceGuardThresholdPercent: 1.25,
    }), "utf8");
    await assert.rejects(
      guarded.request("gs.usrLand.harvest", { landId: 1002 }),
      (error) => (
        error?.reason === "experience-action-blocked"
        && error?.experienceGuard?.thresholdPercent === 1.25
        && error?.experienceGuard?.thresholdRemainingExp === 13
        && error?.experienceGuard?.remainingToProtectionExp === 87
        && /1\.25%门槛/.test(error?.experienceGuard?.reasonText || "")
      ),
    );
    assert.equal(harvestRequests, 1);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("readPackageAppVersionFromManifest reads package appVersion and falls back when missing", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-manifest-"));
  try {
    const { readPackageAppVersionFromManifest } = await import(`./inspect-garden-dryrun.mjs?manifest-version-test=${Date.now()}`);
    const manifestPath = path.join(outDir, "Manifest.xml");
    fs.writeFileSync(manifestPath, [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<package>",
      "  <uid>2021004163668677</uid>",
      "  <appVersion>351.0.2</appVersion>",
      "</package>",
    ].join("\n"), "utf8");

    assert.equal(readPackageAppVersionFromManifest(manifestPath, "fallback"), "351.0.2");
    assert.equal(readPackageAppVersionFromManifest(path.join(outDir, "missing.xml"), "fallback"), "fallback");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("getLoginPackageInfo prefers latest local manifest over pack userParams appVersion", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-login-package-"));
  try {
    const { getLoginPackageInfo } = await import(`./inspect-garden-dryrun.mjs?login-package-test=${Date.now()}`);
    const manifestPath = path.join(outDir, "Manifest.xml");
    fs.writeFileSync(manifestPath, [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<package>",
      "  <uid>2021004163668677</uid>",
      "  <appVersion>360.0.17</appVersion>",
      "</package>",
    ].join("\n"), "utf8");

    const info = getLoginPackageInfo({ appVersion: "2.2.209", packageId: "520" }, { manifestPath });

    assert.equal(info.appVersion, "360.0.17");
    assert.equal(info.manifestAppVersion, "360.0.17");
    assert.equal(info.appVersionSource, "local-manifest");
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("run-auto-plant loop has a single-instance guard with explicit ForceLoop override", () => {
  const script = fs.readFileSync(path.join("work", "run-auto-plant.ps1"), "utf8");

  assert.match(script, /\[switch\]\$ForceLoop/);
  assert.match(script, /function Get-AutoLoopInstances/);
  assert.match(script, /\$Loop -and !\$ForceLoop/);
  assert.match(script, /Another xjskp auto loop is already running/);
});

test("session-expired errors are classified as login-state stops", async () => {
  const {
    SESSION_EXPIRED_EXIT_CODE,
    buildAutomationStoppedSummary,
    classifyAutomationError,
    isSessionExpiredPayload,
  } = await import(`./inspect-garden-dryrun.mjs?session-expired-test=${Date.now()}`);

  assert.equal(SESSION_EXPIRED_EXIT_CODE, 42);
  assert.equal(isSessionExpiredPayload({ type: 90000 }), true);
  assert.equal(isSessionExpiredPayload({ nested: { errMsg: { message: "账号已在其他设备登录" } } }), true);
  assert.equal(isSessionExpiredPayload("会话已过期，请重新登录"), true);
  assert.equal(isSessionExpiredPayload("token invalid or unauthorized"), true);
  assert.equal(isSessionExpiredPayload("WS request timeout gs.usr.heartTick"), false);

  const classified = classifyAutomationError(new Error("账号已在其他设备登录"));
  assert.equal(classified.reason, "session-expired");
  assert.equal(classified.category, "login-state");
  assert.equal(classified.exitCode, SESSION_EXPIRED_EXIT_CODE);
  assert.match(classified.message, /其他设备登录|会话已失效/);

  const wrapped = Object.assign(new Error('业务响应：会话已过期，请重新登录'), {
    automationClassification: { category: "business-rejected" },
    response: { type: 90000, msg: "会话已过期，请重新登录" },
  });
  assert.deepEqual(classifyAutomationError(wrapped), {
    reason: "session-expired",
    category: "login-state",
    exitCode: SESSION_EXPIRED_EXIT_CODE,
    message: "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。",
    rawMessage: "业务响应：会话已过期，请重新登录",
  });

  for (const message of [
    "business rejected: unauthorized",
    "业务拒绝，请重新登录后再试",
    '{"type":90000,"msg":"仅文本，不能作为结构化会话凭据"}',
  ]) {
    const protectedBusinessRejected = Object.assign(new Error(message), {
      automationClassification: { category: "business-rejected" },
    });
    assert.deepEqual(classifyAutomationError(protectedBusinessRejected), {
      reason: "protected-business-rejected",
      category: "business-rejected",
      exitCode: 0,
      message,
      rawMessage: message,
      automationClassification: { category: "business-rejected" },
    });
  }

  const summary = buildAutomationStoppedSummary(new Error("账号已在其他设备登录"), {
    cycle: 7,
    step: "loopWaitError",
    now: () => new Date("2026-06-30T08:00:00.000Z"),
  });
  assert.equal(summary.automationStopped.stopped, true);
  assert.equal(summary.automationStopped.reason, "session-expired");
  assert.equal(summary.automationStopped.category, "login-state");
  assert.equal(summary.automationStopped.cycle, 7);
  assert.equal(summary.automationStopped.step, "loopWaitError");
  assert.equal(summary.automationStopped.exitCode, 42);
  assert.equal(summary.automationStopped.stoppedAt, "2026-06-30 16:00:00");
  assert.equal(summary.loopError, "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。");
});

test("experience interface compatibility helper separates team submission from reward settlement", async () => {
  const { isExperienceRewardIface } = await import(
    `./inspect-garden-dryrun.mjs?team-order-experience-ifaces=${Date.now()}`
  );

  assert.equal(isExperienceRewardIface("gs.orderTeam.takeOrder"), false);
  assert.equal(isExperienceRewardIface("gs.orderTeam.takeStoredOrder"), false);
  assert.equal(isExperienceRewardIface("gs.orderTeam.submitOrder"), false);
  assert.equal(isExperienceRewardIface("gs.orderTeam.recvRwd"), true);
  for (const iface of [
    "gs.orderTeam.refreshOrder",
    "gs.orderTeam.storeOrder",
  ]) {
    assert.equal(isExperienceRewardIface(iface), false, iface);
  }
});

test("0.5 percent experience threshold is an actual protection boundary", async () => {
  const { summarizeExperienceGuard } = await import(
    `./inspect-garden-dryrun.mjs?experience-status-only-threshold=${Date.now()}`
  );

  const guard = summarizeExperienceGuard({
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 9_950_000,
        nextExp: 10_000_000,
      },
    },
  });

  assert.equal(guard.blocked, true);
  assert.equal(guard.thresholdReached, true);
  assert.equal(guard.thresholdPercent, 0.5);
  assert.equal(guard.thresholdRemainingExp, 50_000);
  assert.equal(guard.reason, "experience-protection-boundary");
});

test("experience guard merges direct experience response before the next action", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?experience-response-merge=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 100 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 800,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
            1002: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  let harvestRequests = 0;
  const settlementAudits = [];
  const ws = {
    async request(iface) {
      if (iface === "gs.usr.lazySync") return raw({});
      if (iface === "gs.usrLand.harvest") {
        harvestRequests += 1;
        return raw({
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 900,
            },
            itemAddChg: {
              itemAddRcdList: [
                {
                  itemMap: {
                    [ITEM_IDS.EXPERIENCE]: 100,
                  },
                },
              ],
            },
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 100,
              },
            },
          },
        });
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    cycle: 1,
    onExperienceSettlementAudit: (entry) => settlementAudits.push(entry),
  });

  const firstRaw = await guarded.request("gs.usrLand.harvest", { landId: 1001 });
  assert.equal(firstRaw.v.$usrTot.oi.bi[ITEM_IDS.EXPERIENCE], 100);
  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1002 }),
    (error) => (
      error?.reason === "experience-action-blocked"
      && error?.experienceGuard?.reason === "experience-protection-boundary"
    ),
  );

  assert.equal(harvestRequests, 1);
  assert.equal(syncRef.current.$usrTot.data.lvlExp, 900);
  const refreshAudit = settlementAudits.find(
    (entry) => entry.iface === "gs.usr.lazySync",
  );
  assert.equal(refreshAudit.resolution, "no-experience-evidence");
  assert.equal(refreshAudit.experienceSource, "no-experience-evidence");
  const harvestAudit = settlementAudits.find(
    (entry) => entry.iface === "gs.usrLand.harvest",
  );
  assert.match(harvestAudit.requestId, /^exp-1-\d+$/);
  assert.equal(harvestAudit.settlementKind, "direct");
  assert.equal(harvestAudit.predictionSource, "flower-level-harvest-exp");
  assert.equal(harvestAudit.predictedMinExp, 100);
  assert.equal(harvestAudit.predictedMaxExp, 100);
  assert.deepEqual(harvestAudit.predictionDetails, {
    landId: 1001,
    flowerId: 23108,
    flowerLevel: 1,
    baseExp: 100,
    flowerSkillExpAdd: 0,
    globalExpAdd: 0,
    configSource: "exact",
  });
  assert.equal(harvestAudit.beforeLevel, 40);
  assert.equal(harvestAudit.beforeExp, 800);
  assert.deepEqual(harvestAudit.absoluteCandidates, [
    { source: "$usrTot.data.lvlExp", value: 900 },
  ]);
  assert.deepEqual(harvestAudit.deltaCandidates, [
    {
      source: "$usrTot.itemAddChg.itemAddRcdList[0].itemMap[2]",
      value: 100,
    },
    { source: "$usrTot.oi.bi[2]", value: 100 },
  ]);
  assert.equal(harvestAudit.deduplicatedDelta, 100);
  assert.equal(harvestAudit.resolvedLevel, 40);
  assert.equal(harvestAudit.resolvedExp, 900);
  assert.equal(harvestAudit.actualExpDelta, 100);
  assert.equal(harvestAudit.resolution, "authoritative-absolute");
  assert.equal(harvestAudit.conflict, false);
  const blockedAudit = settlementAudits.find(
    (entry) => (
      entry.iface === "gs.usrLand.harvest"
      && entry.experienceSource === "blocked-before-request"
    ),
  );
  assert.match(blockedAudit.requestId, /^exp-1-\d+$/);
  assert.equal(blockedAudit.settlementKind, "direct");
  assert.equal(blockedAudit.predictedMaxExp, 100);
});

test("experience guard fails closed when lazySync regresses within the same level", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?experience-lazy-regression=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 10 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  const settlementAudits = [];
  let harvestRequests = 0;
  const ws = {
    async request(iface) {
      if (iface === "gs.usr.lazySync") {
        return raw({
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 90,
            },
          },
        });
      }
      if (iface === "gs.usrLand.harvest") {
        harvestRequests += 1;
        return raw({});
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    cycle: 7,
    onExperienceSettlementAudit: (entry) => settlementAudits.push(entry),
  });

  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => (
      error?.reason === "experience-action-blocked"
      && error?.experienceGuard?.reason === "experience-snapshot-regression"
    ),
  );

  assert.equal(harvestRequests, 0);
  assert.equal(syncRef.current.$usrTot.data.lvlExp, 100);
  const regression = settlementAudits.find(
    (entry) => entry.step === "experienceSnapshotRegression",
  );
  assert.equal(regression.requestId, "exp-7-1");
  assert.equal(regression.beforeLevel, 40);
  assert.equal(regression.beforeExp, 100);
  assert.equal(regression.resolvedLevel, 40);
  assert.equal(regression.resolvedExp, 100);
  assert.equal(regression.conflict, true);
  assert.equal(
    regression.conflictReason,
    "same-level-experience-regression",
  );
  const blockedActionAudit = settlementAudits.find(
    (entry) => entry.experienceSource === "blocked-evidence-conflict",
  );
  assert.equal(blockedActionAudit.requestId, "exp-7-2");
  assert.equal(blockedActionAudit.iface, "gs.usrLand.harvest");
  assert.equal(blockedActionAudit.settlementKind, "direct");
  assert.equal(blockedActionAudit.predictedMaxExp, 10);
  assert.equal(blockedActionAudit.conflict, true);
  assert.equal(
    blockedActionAudit.conflictReason,
    "same-level-experience-regression",
  );
});

test("experience regression lets an active team order settle atomically before blocking ordinary rewards", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?experience-active-team-regression=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 10 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
      orderTeamTot: {
        orderTeam: {
          status: 3,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  const requests = [];
  const settlementAudits = [];
  const ws = {
    async request(iface) {
      requests.push(iface);
      if (iface === "gs.usr.lazySync") {
        return raw({
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 90,
            },
          },
        });
      }
      if (iface === "gs.orderTeam.recvRwd") {
        return raw({
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 150,
              nextExp: 1_000,
            },
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 50,
              },
            },
          },
          orderTeamTot: {
            orderTeam: {
              status: 0,
            },
          },
        });
      }
      if (iface === "gs.usrLand.harvest") return raw({});
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    onExperienceSettlementAudit: (entry) => settlementAudits.push(entry),
  });

  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => error?.experienceGuard?.reason === "experience-snapshot-regression",
  );
  const rewardRaw = await guarded.request("gs.orderTeam.recvRwd", {});
  assert.equal(rewardRaw.v.$usrTot.data.lvlExp, 150);
  assert.equal(syncRef.current.$usrTot.data.lvlExp, 150);
  assert.equal(syncRef.current.orderTeamTot.orderTeam.status, 0);
  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => error?.reason === "experience-guard",
  );
  assert.deepEqual(requests, [
    "gs.usr.lazySync",
    "gs.usr.lazySync",
    "gs.orderTeam.recvRwd",
  ]);
  const rewardAudit = settlementAudits.find(
    (entry) => entry.iface === "gs.orderTeam.recvRwd",
  );
  assert.match(rewardAudit.requestId, /^exp-na-\d+$/);
  assert.equal(rewardAudit.actualExpDelta, 50);
  const postTeamBlockedAudit = settlementAudits.find(
    (entry) => entry.experienceSource === "blocked-existing-conflict",
  );
  assert.match(postTeamBlockedAudit.requestId, /^exp-na-\d+$/);
  assert.equal(postTeamBlockedAudit.iface, "gs.usrLand.harvest");
  assert.equal(postTeamBlockedAudit.conflict, true);
  assert.equal(
    postTeamBlockedAudit.conflictReason,
    "same-level-experience-regression",
  );
});

test("authorized no-history team cold start reaches the exact resident trigger request", async () => {
  const {
    createExperienceGuardedWs,
    requestResidentOrderAction,
  } = await import(
    `./inspect-garden-dryrun.mjs?team-cold-start-request=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map([
      [23001, { id: 23001, experience: 100 }],
    ]),
    flowerLevelExact: new Map(),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 49,
          lvlExp: 994,
          nextExp: 1_000,
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 1]],
          },
        },
      },
    },
  };
  const requests = [];
  const ws = {
    async request(iface, args) {
      requests.push({ iface, args });
      if (iface === "gs.usr.lazySync") return raw({});
      if (iface === "gs.orderFlower.finishSatinOrder") {
        return raw({
          $usrTot: {
            data: {
              lvl: 50,
              lvlExp: 94,
              nextExp: 2_000,
            },
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 100,
              },
            },
          },
        });
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
  });
  const action = {
    kind: "satin",
    iface: "gs.orderFlower.finishSatinOrder",
    args: {},
    residentBoardTotalBefore: 49,
    residentBoardTotalAfter: 50,
    teamTriggerDecision: {
      blocked: false,
      coldStartBypass: true,
      reason: "cold-start-user-authorized",
      teamOrderReservationId: "team-exp-test-cold-start",
    },
  };

  await requestResidentOrderAction(
    guarded,
    "token",
    action,
    "satin order submit failed",
  );

  assert.equal(
    requests.filter((entry) => entry.iface === "gs.orderFlower.finishSatinOrder").length,
    1,
  );
});

test("experience guard serializes concurrent reward actions and releases the lock after errors", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?experience-action-lock=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 10 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
            1002: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  let releaseFirst;
  const firstStarted = new Promise((resolve) => {
    releaseFirst = { resolve, reject: null };
  });
  let unblockFirst;
  const firstBlocked = new Promise((resolve, reject) => {
    unblockFirst = { resolve, reject };
  });
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const harvestCalls = [];
  const ws = {
    async request(iface, args) {
      if (iface === "gs.usr.lazySync") return raw({});
      assert.equal(iface, "gs.usrLand.harvest");
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      harvestCalls.push(args.landId);
      try {
        if (args.landId === 1001) {
          releaseFirst.resolve();
          await firstBlocked;
          throw new Error("first harvest failed");
        }
        return raw({
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 110,
              nextExp: 1_000,
            },
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 10,
              },
            },
          },
        });
      } finally {
        activeRequests -= 1;
      }
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
  });

  const first = guarded.request("gs.usrLand.harvest", { landId: 1001 });
  await firstStarted;
  const second = guarded.request("gs.usrLand.harvest", { landId: 1002 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harvestCalls, [1001]);

  unblockFirst.resolve();
  await assert.rejects(first, /first harvest failed/);
  await second;

  assert.deepEqual(harvestCalls, [1001, 1002]);
  assert.equal(maxActiveRequests, 1);
  assert.equal(syncRef.current.$usrTot.data.lvlExp, 110);
});

test("experience guard audits a sent reward request that fails and preserves the original error", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?experience-request-error-audit=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 10 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  const requestError = new Error("harvest request failed");
  const settlementAudits = [];
  const ws = {
    async request(iface) {
      if (iface === "gs.usr.lazySync") return raw({});
      if (iface === "gs.usrLand.harvest") throw requestError;
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    cycle: 9,
    onExperienceSettlementAudit: (entry) => settlementAudits.push(entry),
  });

  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => error === requestError,
  );
  const requestAudit = settlementAudits.find(
    (entry) => entry.experienceSource === "request-failed",
  );
  assert.match(requestAudit.requestId, /^exp-9-\d+$/);
  assert.equal(requestAudit.iface, "gs.usrLand.harvest");
  assert.equal(requestAudit.settlementKind, "direct");
  assert.equal(requestAudit.predictedMaxExp, 10);
  assert.equal(requestAudit.conflict, false);
  assert.equal(requestAudit.conflictReason, null);
});

test("experience guard audits response item 2 when an underprediction crosses a level", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?experience-cross-level-audit=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 100 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 49,
          lvlExp: 800,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
            1002: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  const audits = [];
  const ws = {
    async request(iface) {
      if (iface === "gs.usr.lazySync") return raw({});
      if (iface === "gs.usrLand.harvest") {
        return raw({
          $usrTot: {
            data: {
              lvl: 50,
              lvlExp: 100,
              nextExp: 2_000,
            },
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 300,
              },
            },
          },
        });
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    onUnexpectedExperienceSettlement: (entry) => audits.push(entry),
  });

  await guarded.request("gs.usrLand.harvest", { landId: 1001 });

  assert.equal(audits.length, 1);
  assert.equal(audits[0].actualExpDelta, 300);
  assert.equal(audits[0].reason, "experience-exceeded-prediction");
  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1002 }),
    (error) => error?.reason === "experience-guard",
  );
});

test("unexpected experience from a none interface is merged before fail-closed", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?unexpected-experience-merge=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map([
      ["2310801", { id: "2310801", harvestExp: 20 }],
    ]),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: { flowerId: 23108, state: 3 },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23108: { flowerId: 23108, lvl: 1 },
        },
      },
    },
  };
  const audits = [];
  const ws = {
    async request(iface) {
      if (iface === "gs.usrLand.water") {
        return raw({
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 101,
              nextExp: 1_000,
            },
            oi: {
              bi: {
                [ITEM_IDS.EXPERIENCE]: 1,
              },
            },
          },
        });
      }
      if (iface === "gs.usr.lazySync") return raw({});
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    onUnexpectedExperienceSettlement: (entry) => audits.push(entry),
  });

  await guarded.request("gs.usrLand.water", { landId: 1001 });
  assert.equal(syncRef.current.$usrTot.data.lvlExp, 101);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actualExpDelta, 1);
  await assert.rejects(
    guarded.request("gs.usrLand.harvest", { landId: 1001 }),
    (error) => error?.reason === "experience-guard",
  );
});

test("experience guard blocks an unclassified interface before sending it", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?unknown-interface-fail-closed=${Date.now()}`
  );
  const experienceConfig = {
    compatible: true,
    reasons: [],
    monthCardExpAdd: 0,
    flowers: new Map(),
    flowerLevelExact: new Map(),
    flowerLevelCfg: new Map(),
    flowerArts: new Map(),
    mainTasks: new Map(),
    cyclicNotes: new Map(),
    flowerAdvanceSkillById: new Map(),
    fashionSuits: new Map(),
    teamOrder: {
      rewardBaseExperience: 8_000,
      orders: new Map(),
    },
  };
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
    },
  };
  const requests = [];
  const ws = {
    async request(iface) {
      requests.push(iface);
      return raw({});
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    experienceConfig,
    getExperienceGuardThresholdPercent: () => 1.25,
  });

  await assert.rejects(
    guarded.request("gs.pearl.draw", {}),
    (error) => (
      error?.reason === "experience-action-blocked"
      && error?.experienceGuard?.reason === "experience-estimate-unknown"
      && error?.experienceGuard?.thresholdPercent === 1.25
      && error?.experienceGuard?.thresholdRemainingExp === 13
      && error?.experienceGuard?.protectionLimitExp === 987
    ),
  );

  assert.deepEqual(requests, ["gs.usr.lazySync"]);
});

test("authority lazy sync merges experience without treating it as a reward action", async () => {
  const { createExperienceGuardedWs } = await import(
    `./inspect-garden-dryrun.mjs?authority-experience-sync=${Date.now()}`
  );
  const syncRef = {
    current: {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 100,
          nextExp: 1_000,
        },
      },
    },
  };
  const audits = [];
  const ws = {
    async request(iface) {
      assert.equal(iface, "gs.usr.lazySync");
      return raw({
        $usrTot: {
          data: {
            lvl: 40,
            lvlExp: 200,
            nextExp: 1_000,
          },
          oi: {
            bi: {
              [ITEM_IDS.EXPERIENCE]: 100,
            },
          },
        },
      });
    },
  };
  const guarded = createExperienceGuardedWs(ws, "token", syncRef, {
    onUnexpectedExperienceSettlement: (entry) => audits.push(entry),
  });

  await guarded.request("gs.usr.lazySync", {});

  assert.equal(syncRef.current.$usrTot.data.lvlExp, 200);
  assert.deepEqual(audits, []);
});

test("runGardenCycle receives non-video waterwheel bucket below threshold and stops before video bucket", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    let waterDrops = 8;
    let waterwheel = { count: 2, advList: [4] };
    const makeCurrentSync = () => {
      const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
      sync.$usrTot.data.bag[7] = waterDrops;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          waterDrops = 13;
          waterwheel = { count: 3, advList: [4] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              oi: {
                bd: {
                  7: waterDrops,
                },
              },
            },
            waterwheel,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.enter"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.skip"), false);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 1);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 1);
    assert.equal(statusJson.summary.waterwheelNormalReceivedCount, 1);
    assert.equal(statusJson.summary.waterwheelVideoBaseReceivedCount, 0);
    assert.equal(statusJson.waterwheel.receivedCount, 1);
    assert.equal(statusJson.waterwheel.normalReceivedCount, 1);
    assert.equal(statusJson.waterwheel.videoBaseReceivedCount, 0);
    assert.equal(statusJson.waterwheel.remainingBucketCount, 57);
    assert.equal(statusJson.waterwheel.remainingDailyBucketCount, 57);
    assert.equal(statusJson.waterwheel.storedBucketCount, 0);
    assert.equal(statusJson.waterwheel.storedBucketMax, 8);
    assert.equal(statusJson.waterwheel.nextBucketNo, null);
    assert.equal(statusJson.waterwheel.nextBucketIsVideo, false);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle consumes exactly one local bucket when the receive advances the daily claim count", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-near-daily-limit-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    WATERWHEEL_MAX_RECEIVES_PER_CYCLE: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });
  saveWaterwheelBucketState({
    statePath: path.join(outDir, "waterwheel-bucket-state.json"),
    state: {
      ...createWaterwheelBucketState({
        profileId: process.env.PROFILE_ID,
        nowMs: Date.now(),
        config: { bucketCreateCd: 30, bucketExistMax: 8, bucketGetMax: 60 },
      }),
      storedBucketCount: 2,
      nextGenerationAtMs: null,
    },
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-near-daily-limit-cycle-test=${Date.now()}`);
    const requestLog = [];
    let waterDrops = 8;
    let waterwheel = { count: 58, advList: [] };
    const makeCurrentSync = () => {
      const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          waterDrops = 16;
          waterwheel = { count: 59, advList: [] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              oi: {
                bd: {
                  [ITEM_IDS.WATER_DROP]: waterDrops,
                },
              },
            },
            waterwheel,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length, 1);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterwheel.claimedBucketCount, 59);
    assert.equal(statusJson.waterwheel.storedBucketCount, 1);
    assert.equal(statusJson.waterwheel.remainingDailyBucketCount, 1);
    const persistedState = JSON.parse(
      fs.readFileSync(path.join(outDir, "waterwheel-bucket-state.json"), "utf8"),
    );
    assert.equal(persistedState.storedBucketCount, 1);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle leaves video waterwheel bucket untouched below threshold", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-video-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-video-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    baseSync.$usrTot.data.bag[7] = 0;
    baseSync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: { count: 2, advList: [3] } });
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.enter"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.skip"), false);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 0);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.waterwheel.nextBucketNo, 3);
    assert.equal(statusJson.waterwheel.nextBucketIsVideo, true);
    assert.equal(statusJson.waterwheel.reason, "next-bucket-video-retained");
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle sends no waterwheel recv or skip without a locally generated bucket", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-no-local-bucket-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });
  saveWaterwheelBucketState({
    statePath: path.join(outDir, "waterwheel-bucket-state.json"),
    state: createWaterwheelBucketState({
      profileId: process.env.PROFILE_ID,
      nowMs: Date.now(),
      config: { bucketCreateCd: 30, bucketExistMax: 8, bucketGetMax: 60 },
    }),
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-no-local-bucket-test=${Date.now()}`);
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 0;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(sync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: sync.waterwheel });
        throw new Error(`unexpected waterwheel action ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.recv" || item.iface === "gs.waterwheel.skip")
        .map((item) => item.iface),
      [],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterwheel.storedBucketCount, 0);
    assert.equal(statusJson.waterwheel.reason, "no-generated-bucket");
    assert.deepEqual(statusJson.waterwheel.pendingWaterwheelActions, []);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle receives waterwheel drops to finish seeded backlog before planting", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-seeded-backlog-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-seeded-backlog-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23034, lvl: 11, nextTime: "2099-07-06T10:28:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let waterDrops = 1;
    let waterwheel = { count: 2, advList: [] };
    let landMap = Object.fromEntries([
      ...makeLandEntries(1017, 14, growing),
      [1031, seeded],
      [1032, seeded],
      ...makeLandEntries(1033, 16, {}),
    ]);
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.$usrTot.data.bag[23034] = 100;
      sync.cultivateTot.cultivateMap[23034] = {
        flowerId: 23034,
        lvl: 11,
        cTime: "2026-07-06T00:00:00.000Z",
      };
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          waterDrops += 3;
          waterwheel = { count: 3, advList: [] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.WATER_DROP]: 3,
                },
              },
            },
            waterwheel,
          });
        }
        if (iface === "gs.usrLand.water") {
          if (landMap[args.landId]?.state === 1) landMap[args.landId] = growing;
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length, 1);
    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.usrLand.water")
        .map((item) => item.args),
      [{ landId: 1031 }, { landId: 1032 }],
    );
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), false);
    assert.equal(result.usrLandTot.usrLand.landMap[1031].state, 2);
    assert.equal(result.usrLandTot.usrLand.landMap[1032].state, 2);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelReceivedCount, 1);
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 2);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps video waterwheel bucket untouched when seeded backlog needs water", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-seeded-video-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-seeded-video-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23034, lvl: 11, nextTime: "2099-07-06T10:28:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    const waterwheel = { count: 2, advList: [3] };
    const landMap = Object.fromEntries([
      ...makeLandEntries(1017, 14, growing),
      [1031, seeded],
      [1032, seeded],
      ...makeLandEntries(1033, 16, {}),
    ]);
    const sync = makeSync(landMap, 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 1;
    sync.$usrTot.data.bag[23034] = 100;
    sync.cultivateTot.cultivateMap[23034] = {
      flowerId: 23034,
      lvl: 11,
      cTime: "2026-07-06T00:00:00.000Z",
    };
    sync.waterwheel = waterwheel;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.enter"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.water"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const seededSkip = parsedLogs.find((entry) => entry.step === "waterSeededGroupSkip");
    assert.equal(seededSkip?.reason, "waiting-water-for-seeded-land-group");

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterwheel.reason, "next-bucket-video-retained");
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waits for authoritative water before receiving waterwheel", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-authority-missing-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-authority-missing-cycle-test=${Date.now()}`);
    const landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    const sync = makeSync(landMap, 100);
    delete sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP];
    sync.waterwheel = { count: 2, advList: [] };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: sync.waterwheel });
        if (iface === "gs.waterwheel.recv") return raw({ waterwheel: { count: 3, advList: [] } });
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.water"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(
      parsedLogs.some((entry) => entry.step === "waterRefillSkip" && entry.reason === "waiting-authoritative-water-drop-before-refill"),
      true,
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "unknown");
    assert.equal(statusJson.waterDecision.canReceiveWater, false);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not plant from waterwheel local delta when post-refill server snapshot is missing", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-over-max-no-authority-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-over-max-no-authority-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 5;
    let waterwheel = { count: 2, advList: [] };
    let lazySyncCount = 0;
    let landRefreshCount = 0;
    const makeCurrentSync = () => {
      const next = makeSync({ ...landMap }, 100);
      next.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      next.waterwheel = waterwheel;
      return next;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          landRefreshCount += 1;
          if (landRefreshCount === 1) return raw(currentSync);
          return raw({ waterwheel });
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          lazySyncCount += 1;
          if (lazySyncCount === 1) {
            return raw({
              $usrTot: {
                data: {
                  bag: {
                    [ITEM_IDS.WATER_DROP]: 5,
                  },
                },
              },
            });
          }
          return raw({});
        }
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          const delta = requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length === 1 ? 8 : 6;
          waterDrops += delta;
          waterwheel = { count: waterwheel.count + 1, advList: [] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: waterDrops - delta,
                },
              },
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.WATER_DROP]: delta,
                },
              },
            },
            waterwheel,
          });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(
      requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length,
      1,
      "expected one waterwheel receive before waiting for an authoritative post-refill snapshot",
    );
    assert.ok(landRefreshCount >= 2, "expected an extra read-only land refresh before trusting post-refill water");
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.water"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterwheelWaterSyncUntrusted"), false);
    assert.equal(
      parsedLogs.some((entry) => entry.step === "waterRefillSkip" && entry.reason === "waiting-authoritative-water-drop-after-refill"),
      true,
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants from authoritative snapshot after over-range waterwheel delta", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-over-max-authority-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const oldNow = Date.now;
  const logs = [];
  const nowMs = Date.parse("2026-07-07T00:10:00.000Z");
  Date.now = () => nowMs;
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-over-max-authority-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 15;
    let waterwheel = { count: 0, advList: [] };
    let refreshCount = 0;
    const makeCurrentSync = () => {
      const next = makeSync({ ...landMap }, 100);
      next.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      next.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(nowMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      next.waterwheel = waterwheel;
      return next;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          refreshCount += 1;
          return raw(currentSync);
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          const oldWaterDrops = waterDrops;
          waterDrops = 29;
          waterwheel = { count: 1, advList: [] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: waterDrops,
                },
              },
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.WATER_DROP]: waterDrops - oldWaterDrops,
                },
              },
            },
            waterwheel,
          });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length, 1);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterwheelWaterSyncUntrusted"), false);
    const rangeLog = parsedLogs.find((entry) => entry.step === "waterwheelWaterDeltaOutOfExpectedRange");
    assert.equal(rangeLog?.receivedWaterDropCount, 14);
    assert.equal(rangeLog?.snapshotTrustedForPlanting, true);
    assert.match(rangeLog?.serverWaterDropSourcePath, /(waterwheelReceive|usrLandRefresh)\.\$usrTot\.(data\.bag|oi\.bd)\[7\]/);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.summary.waterwheelReceivedCount, 1);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not restore action water authority from a merged local snapshot after prior waterwheel downgrade", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-downgrade-restore-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-07T00:20:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-downgrade-restore-cycle-test=${Date.now()}`);
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 29;
    const waterwheel = { count: 1, advList: [] };
    const makeCurrentSync = () => {
      const next = makeSync({ ...landMap }, 100);
      next.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      next.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(nowMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      next.waterwheel = waterwheel;
      next.__xjskpWaterDropAuthority = {
        trust: "unknown",
        serverWaterDropReason: "waterwheel-water-sync-untrusted",
      };
      return next;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          return raw({
            usrLandTot: {
              usrLand: {
                landMap: { ...landMap },
              },
            },
          });
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") throw new Error("waterwheel should not be received");
        if (iface === "gs.usrLand.plant") throw new Error("planting must wait for a raw server water snapshot");
        if (iface === "gs.usrLand.water") throw new Error("watering must wait for a raw server water snapshot");
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 0);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 0);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.notEqual(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.blockedReason, "waiting-authoritative-water-drop-before-refill");
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle performs a land refresh before blocking when restored water could cover a plant group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-preplant-authority-refresh-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-07T06:30:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?preplant-authority-refresh-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 14;
    const restoreStartMs = nowMs - 4 * 120 * 1000;
    const waterwheel = { count: 50, advList: [] };
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(restoreStartMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      sync.waterwheel = waterwheel;
      sync.__xjskpWaterDropAuthority = {
        trust: "unknown",
        serverWaterDropReason: "missing-post-refill-server-water-drop-snapshot",
      };
      return sync;
    };
    const makeLandOnlyPatch = () => ({
      usrLandTot: {
        usrLand: {
          landMap: { ...landMap },
        },
      },
      waterwheel,
    });
    let currentSync = makeCurrentSync();
    let landRefreshCount = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          landRefreshCount += 1;
          return raw(landRefreshCount === 1 ? makeLandOnlyPatch() : currentSync);
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") throw new Error("waterwheel should not be received when refreshed water is enough");
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.ok(landRefreshCount >= 2, "expected an extra read-only land refresh before blocking planting");
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.reason, "plant-water-enough");
    assert.match(statusJson.waterDecision.serverWaterDropSourcePath, /itemExtMap\[7\]/);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants from a preserved server water baseline with client restore", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-client-water-restore-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-07T15:40:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?client-water-restore-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries([
      ...makeLandEntries(1001, 16, growing),
      ...makeLandEntries(1017, 48, {}),
    ]);
    let waterDrops = 38;
    const restoreStartMs = nowMs - 27 * 120 * 1000;
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(restoreStartMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      sync.waterwheel = { count: 50, advList: [] };
      return sync;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw({ usrLandTot: { usrLand: { landMap: { ...landMap } } } });
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: currentSync.waterwheel });
        if (iface === "gs.waterwheel.recv") throw new Error("waterwheel should not be received when client-computed water is enough");
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    const plantCalls = requestLog.filter((item) => item.iface === "gs.usrLand.plant");
    const waterCalls = requestLog.filter((item) => item.iface === "gs.usrLand.water");
    assert.deepEqual(
      plantCalls.slice(0, 16).map((item) => item.args.landId),
      Array.from({ length: 16 }, (_, index) => 1017 + index),
    );
    assert.equal(plantCalls.length, 48);
    assert.equal(waterCalls.length, 48);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.reason, "plant-water-enough");
    assert.equal(statusJson.waterDecision.serverWaterDropReason, "client-computed-server-baseline");
    assert.equal(statusJson.summary.plantedCount, 48);
    assert.equal(statusJson.summary.wateredCount, 48);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants from an itemExt-only client water baseline with implicit zero bag", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-item-ext-water-restore-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-07T16:20:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?item-ext-water-restore-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    const restoreStartMs = nowMs - 16 * 120 * 1000;
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      delete sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP];
      sync.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(restoreStartMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      sync.waterwheel = { count: 50, advList: [] };
      return sync;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw({ usrLandTot: { usrLand: { landMap: { ...landMap } } } });
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: currentSync.waterwheel });
        if (iface === "gs.waterwheel.recv") throw new Error("waterwheel should not be received when restored water is enough");
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.reason, "plant-water-enough");
    assert.equal(statusJson.waterDecision.serverWaterDropReason, "client-computed-server-baseline");
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle uses waterwheel oi.bd absolute water with an existing server baseline", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-absolute-water-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-07T07:10:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-absolute-water-cycle-test=${Date.now()}`);
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let waterDrops = 8;
    let waterwheel = { count: 0, advList: [] };
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(nowMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    let landRefreshCount = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          landRefreshCount += 1;
          if (requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length === 0) {
            return raw(currentSync);
          }
          return raw({ usrLandTot: { usrLand: { landMap: { ...landMap } } } });
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          const oldWaterDrops = waterDrops;
          const delta = 10;
          waterDrops += delta;
          waterwheel = { count: waterwheel.count + 1, advList: [] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              oi: {
                bd: {
                  [ITEM_IDS.WATER_DROP]: waterDrops,
                },
              },
            },
            waterwheel,
            __oldWaterDrops: oldWaterDrops,
          });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length, 1);
    assert.ok(landRefreshCount >= 2, "expected a read-only land refresh after the waterwheel delta");
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 1);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 1);
    assert.equal(statusJson.waterDecision.reason, "plant-water-enough");
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick runs read-only asset sync on its own interval without status refresh", async () => {
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_REFRESH_INTERVAL_SECONDS: "0",
    ASSET_SYNC_INTERVAL_SECONDS: "10",
  });

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?asset-sync-wait-test=${Date.now()}`);
    let nowMs = Date.parse("2026-07-07T08:00:00.000Z");
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 5;
    const ws = {
      async request(iface) {
        requestLog.push({ iface, at: nowMs });
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: 9,
                },
                itemExtMap: {
                  [ITEM_IDS.WATER_DROP]: {
                    lems: new Date(nowMs).toISOString(),
                    resetNum: 65,
                    restoreNum: 1,
                    cd: 120 * 1000,
                  },
                },
              },
            },
          });
        }
        if (iface === "gs.usrLand.refresh") return raw({ usrLandTot: { usrLand: { landMap: sync.usrLandTot.usrLand.landMap } } });
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    const waitFn = async (ms) => {
      nowMs += ms;
    };

    const result = await waitWithOnlineHeartTick(ws, "test-token", sync, 25_000, {
      nowFn: () => nowMs,
      waitFn,
      growthHandler: async (_ws, _token, next) => ({ syncValue: next }),
      customerOrderRefresher: async (_ws, _token, next) => next,
      statusWriter: () => {},
    });

    assert.equal(requestLog.filter((item) => item.iface === "gs.usr.lazySync").length, 2);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.refresh").length, 0);
    assert.equal(result.$usrTot.data.bag[ITEM_IDS.WATER_DROP], 9);
  } finally {
    process.env = oldEnv;
  }
});

test("waitWithOnlineHeartTick shares one authoritative snapshot and cuts idle game requests by at least eighty percent", async () => {
  const oldEnv = { ...process.env };
  assignCycleEnv({
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    STATUS_REFRESH_INTERVAL_SECONDS: "5",
    ACCOUNT_SNAPSHOT_INTERVAL_SECONDS: "30",
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
  });
  delete process.env.ASSET_SYNC_INTERVAL_SECONDS;

  try {
    const [{ waitWithOnlineHeartTick }, { createAccountScheduler }] = await Promise.all([
      import(`./inspect-garden-dryrun.mjs?shared-authority-wait-test=${Date.now()}`),
      import("./account-scheduler.mjs"),
    ]);
    let nowMs = Date.parse("2026-08-11T10:00:00.000Z");
    const requestLog = [];
    const statusWrites = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    const ws = {
      async request(iface) {
        requestLog.push({ iface, at: nowMs });
        if (iface === "gs.usr.lazySync") return raw({ $usrTot: sync.$usrTot });
        if (iface === "gs.usrLand.refresh") return raw({ usrLandTot: sync.usrLandTot });
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    const scheduler = createAccountScheduler({ accountId: "idle-budget", nowFn: () => nowMs });

    await waitWithOnlineHeartTick(ws, "test-token", sync, 60_000, {
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      accountScheduler: scheduler,
      growthHandler: async (_ws, _token, next) => ({ syncValue: next }),
      customerOrderRefresher: async (_ws, _token, next) => next,
      statusWriter: (value, context) => statusWrites.push({ value, context }),
    });

    const oldIdleRequestBudget = (11 * 3) + 1;
    assert.ok(
      requestLog.length <= Math.floor(oldIdleRequestBudget * 0.2),
      `expected at least 80% reduction from ${oldIdleRequestBudget}, got ${requestLog.length}`,
    );
    assert.deepEqual(
      requestLog.map((item) => item.iface),
      ["gs.usr.heartTick", "gs.usr.lazySync", "gs.usrLand.refresh"],
    );
    assert.equal(statusWrites.length, 1);
    assert.equal(scheduler.snapshot().authority.refreshCount, 1);
    assert.equal(scheduler.snapshot().modules.statusArtifact, undefined);
    assert.equal(scheduler.snapshot().modules.authoritativeSnapshot.nextRunAtMs, Date.parse("2026-08-11T10:01:00.000Z"));
  } finally {
    process.env = oldEnv;
  }
});

test("runGardenCycle never receives water sources when water already covers a plant group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-enough-no-recv-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-enough-no-recv-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 84;
    const waterwheel = { count: 40, advList: [41] };
    const setSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      sync.freeWater = { recvIdx: [], rTime: "2026-06-16T12:00:00.000Z" };
      return sync;
    };
    let currentSync = setSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = setSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = setSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.freeWater.recv"), false);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterEnoughNoReceive" && entry.source === "waterwheel"), true);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterEnoughNoReceive" && entry.source === "freeWater"), true);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.statusMode, "cycle-action");
    assert.equal(statusJson.waterDecision.reason, "plant-water-enough");
    assert.equal(statusJson.waterDecision.canReceiveWater, false);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants from authoritative water when local water is below group requirement", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-authoritative-water-enough-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?authoritative-water-enough-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 19;
    const waterwheel = { count: 2, advList: [] };
    const setSync = (waterOverride = waterDrops) => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterOverride;
      sync.waterwheel = waterwheel;
      return sync;
    };
    const initialSync = setSync(5);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(setSync());
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({
          $usrTot: {
            data: {
              bag: {
                [ITEM_IDS.WATER_DROP]: waterDrops,
              },
            },
          },
        });
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") return raw({ waterwheel: { count: 3, advList: [] } });
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          return raw(setSync());
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          return raw(setSync());
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps authoritative refresh water when lazySync is sparse", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-sparse-lazysync-water-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?sparse-lazysync-water-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 43;
    const waterwheel = { count: 40, advList: [] };
    const setSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      sync.freeWater = { recvIdx: [], rTime: "2026-06-16T12:00:00.000Z" };
      return sync;
    };
    let currentSync = setSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.freeWater.recv") return raw({
          $usrTot: {
            itemAddChg: {
              itemMap: {
                [ITEM_IDS.WATER_DROP]: 30,
              },
            },
          },
        });
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = setSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = setSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.freeWater.recv"), false);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.reason, "plant-water-enough");
    assert.match(statusJson.waterDecision.serverWaterDropSourcePath, /^usrLandRefresh\.\$usrTot\.data\.bag\[7\]$/);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants from server snapshot restored water when lazySync is sparse", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-restored-snapshot-water-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-06T15:20:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_HANDLE_FREE_WATER: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?restored-snapshot-water-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterBase = 8;
    const waterwheel = { count: 60, advList: [] };
    const restoreStartMs = nowMs - 33 * 120 * 1000;
    const setSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterBase;
      sync.$usrTot.data.itemExtMap = {
        [ITEM_IDS.WATER_DROP]: {
          lems: new Date(restoreStartMs).toISOString(),
          resetNum: 65,
          restoreNum: 1,
          cd: 120 * 1000,
        },
      };
      sync.waterwheel = waterwheel;
      sync.freeWater = { recvIdx: [0, 1], rTime: "2026-07-06T13:00:00.000Z" };
      return sync;
    };
    let currentSync = setSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.freeWater.recv") throw new Error("free water should not be received");
        if (iface === "gs.waterwheel.recv") throw new Error("waterwheel should not be received");
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = setSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterBase = Math.max(0, waterBase - 1);
          currentSync = setSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws, { allowUnknownWater: true }), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.freeWater.recv"), false);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 16);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 16);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.serverWaterDropCount, 41);
    assert.match(statusJson.waterDecision.serverWaterDropSourcePath, /itemExtMap\[7\]/);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle trusts pre-plant lazySync water below group requirement after refill", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-refill-lower-lazysync-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?refill-lower-lazysync-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 15;
    let waterwheel = { count: 2, advList: [] };
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: 14,
                },
              },
            },
          });
        }
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          const oldWaterDrops = waterDrops;
          waterDrops += 5;
          waterwheel = { count: 3, advList: [] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: waterDrops,
                },
              },
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.WATER_DROP]: 5,
                },
              },
            },
            waterwheel,
          });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length, 1);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.water"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterDropSyncPending" && entry.source === "waterwheel"), true);
    const inventoryRefresh = parsedLogs.find((entry) => entry.step === "cycleInventoryRefreshBeforePlant");
    assert.equal(inventoryRefresh, undefined);
    const emptySkip = parsedLogs.find((entry) => entry.step === "plantEmptySkip");
    assert.equal(emptySkip?.reason, "water-drop-sync-pending");
    assert.equal(emptySkip?.waterDropCount, 14);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
    assert.equal(statusJson.summary.waterDropText, "14/65");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle receives non-video waterwheel bucket item delta when planting needs a sixteen-water group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-plant-need-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeCurrentSync = (landMap, waterDrops, waterwheel = { count: 2, advList: [] }) => {
    const sync = makeSync(landMap, 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.waterwheel = waterwheel;
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-plant-need-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [1001 + index, {}]));
    let waterDrops = 12;
    let waterwheel = { count: 2, advList: [] };
    let currentSync = makeCurrentSync(landMap, waterDrops, waterwheel);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          const oldWaterDrops = waterDrops;
          waterDrops += 5;
          waterwheel = { count: 3, advList: [] };
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, waterwheel);
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: oldWaterDrops,
                },
              },
              itemAddChg: { itemMap: { [ITEM_IDS.WATER_DROP]: 5 } },
            },
            waterwheel,
          });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, waterwheel);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, waterwheel);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), true);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 1);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 1);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waits when bucket advances before authoritative water drop sync", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-stale-water-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    WATERWHEEL_SYNC_POLL_ATTEMPTS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-stale-water-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [1001 + index, {}]));
    const makeCurrentSync = (waterwheel) => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 9;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let waterwheel = { count: 2, advList: [] };
    let currentSync = makeCurrentSync(waterwheel);
    const makeLandPatch = () => ({
      usrLandTot: {
        usrLand: {
          landMap: { ...landMap },
        },
      },
      waterwheel,
    });
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(makeLandPatch());
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          const staleSync = makeCurrentSync(waterwheel);
          staleSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 9;
          return raw(staleSync);
        }
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          waterwheel = { count: waterwheel.count + 1, advList: [] };
          currentSync = makeCurrentSync(waterwheel);
          return raw({ waterwheel });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          return raw(makeLandPatch());
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          return raw(makeLandPatch());
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.waterwheel.recv").length, 1);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usr.lazySync").length >= 1, true);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.plant").length, 0);
    assert.equal(requestLog.filter((item) => item.iface === "gs.usrLand.water").length, 0);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterwheelConservativeCredit"), false);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterDropSyncPending" && entry.source === "waterwheel"), true);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterwheelReceiveStop"), true);
    assert.equal(parsedLogs.some((entry) => entry.step === "cycleError"), false);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterRefillBlockedReason, "water-drop-sync-pending");
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not receive waterwheel bucket when water covers final partial group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-final-partial-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeCurrentSync = (landMap, waterDrops, waterwheel = { count: 2, advList: [] }) => {
    const sync = makeSync(landMap, 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.waterwheel = waterwheel;
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?waterwheel-final-partial-cycle-test=${Date.now()}`);
    const growing = { state: 2, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2099-06-16T10:40:00.000Z", harvestCnt: 0 };
    const finalPartialLandIds = makeLandIds(1017, 7);
    let landMap = Object.fromEntries([
      ...makeLandEntries(1001, 16, growing),
      ...finalPartialLandIds.map((landId) => [landId, {}]),
    ]);
    let waterDrops = finalPartialLandIds.length;
    const waterwheel = { count: 2, advList: [] };
    let currentSync = makeCurrentSync(landMap, waterDrops, waterwheel);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") return raw({ waterwheel: { count: 3, advList: [] } });
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, waterwheel);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, waterwheel);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.waterwheel.recv"), false);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 0);
    assert.equal(statusJson.summary.plantedCount, finalPartialLandIds.length);
    assert.equal(statusJson.summary.wateredCount, finalPartialLandIds.length);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle receives free water when planting needs a sixteen-water group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-free-water-plant-need-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T12:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_FREE_WATER: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeCurrentSync = (landMap, waterDrops, freeWater = { recvIdx: [], rTime: "2026-06-16T12:00:00.000Z" }) => {
    const sync = makeSync(landMap, 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.freeWater = freeWater;
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?free-water-plant-need-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [1001 + index, {}]));
    let waterDrops = 15;
    let freeWater = { recvIdx: [], rTime: "2026-06-16T12:00:00.000Z" };
    let currentSync = makeCurrentSync(landMap, waterDrops, freeWater);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.freeWater.recv") {
          waterDrops += 30;
          freeWater = { recvIdx: [args.idx], rTime: "2026-06-16T12:00:00.000Z" };
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, freeWater);
          return raw({ $usrTot: { itemAddChg: { itemMap: { 7: 30 } } }, freeWater });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, freeWater);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync({ ...landMap }, waterDrops, freeWater);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.freeWater.recv"), true);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.freeWaterActionCount, 1);
    assert.equal(statusJson.summary.freeWaterReceivedCount, 1);
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick records status refresh errors without aborting loop", async () => {
  const oldEnv = { ...process.env };
  assignCycleEnv({
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
  });

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?wait-status-error-test=${Date.now()}`);
    let now = 1000;
    let statusRefreshCount = 0;
    const statusWrites = [];
    const ws = {
      async request(iface) {
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await waitWithOnlineHeartTick(ws, "test-token", { marker: "sync" }, 16, {
      cycle: 7,
      nowFn: () => now,
      waitFn: async (ms) => {
        now += Math.max(1, Math.floor(ms));
      },
      statusRefreshIntervalMs: 5,
      statusRefresher: async () => {
        statusRefreshCount++;
        throw new Error("temporary status snapshot error");
      },
      statusWriter: (syncValue, context) => {
        statusWrites.push({ syncValue, context });
      },
      customerOrderRefresher: async (wsArg, tokenArg, syncValue) => syncValue,
    });

    assert.deepEqual(result, { marker: "sync" });
    assert.ok(statusRefreshCount >= 1);
    assert.ok(statusWrites.some((item) => item.context.step === "loopStatusRefreshError"));
    assert.match(
      statusWrites.find((item) => item.context.step === "loopStatusRefreshError").context.summary.loopError,
      /temporary status snapshot error/,
    );
  } finally {
    process.env = oldEnv;
  }
});

test("waitWithOnlineHeartTick rethrows websocket status refresh timeouts for reconnect", async () => {
  const oldEnv = { ...process.env };
  assignCycleEnv({
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
  });

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?wait-ws-timeout-test=${Date.now()}`);
    let now = 1000;
    let statusRefreshCount = 0;
    const statusWrites = [];
    const ws = {
      async request(iface) {
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await assert.rejects(
      () => waitWithOnlineHeartTick(ws, "test-token", { marker: "sync" }, 16, {
        cycle: 7,
        nowFn: () => now,
        waitFn: async (ms) => {
          now += Math.max(1, Math.floor(ms));
        },
        statusRefreshIntervalMs: 5,
        statusRefresher: async () => {
          statusRefreshCount++;
          throw new Error("WS request timeout gs.usrLand.speedUpFree");
        },
        statusWriter: (syncValue, context) => {
          statusWrites.push({ syncValue, context });
        },
        customerOrderRefresher: async (wsArg, tokenArg, syncValue) => syncValue,
      }),
      /WS request timeout gs\.usrLand\.speedUpFree/,
    );
    assert.equal(statusRefreshCount, 1);
    assert.deepEqual(statusWrites, []);
  } finally {
    process.env = oldEnv;
  }
});

test("runGardenCycle sends no waterwheel recv or skip when the profile parent switch is disabled", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-profile-disabled-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: false,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-profile-disabled-cycle-test=${Date.now()}`
    );
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 0;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(sync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: sync.waterwheel });
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.recv" || item.iface === "gs.waterwheel.skip")
        .map((item) => item.iface),
      [],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 0);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.waterwheel.configuredAutoReceiveEnabled, false);
    assert.equal(statusJson.waterwheel.effectiveAutoReceiveEnabled, false);
    assert.equal(statusJson.waterwheel.autoReceiveEnabled, false);
    assert.equal(statusJson.waterwheel.configuredSkipVideoBucketsEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveSkipVideoBucketsEnabled, false);
    assert.equal(statusJson.waterwheel.skipVideoBucketsEnabled, false);
    assert.equal(statusJson.waterwheel.autoReceiveSettingSource, "profile-setting");
    assert.equal(statusJson.waterwheel.autoReceiveDisabledReason, "profile-setting-disabled");
    assert.deepEqual(statusJson.waterwheel.pendingWaterwheelActions, []);
    assert.equal(statusJson.waterwheel.waterDropText, "0/65");
    assert.equal(statusJson.waterwheel.remainingBucketCount, 58);
    assert.equal(statusJson.waterwheel.nextBucketNo, 3);
    assert.equal(statusJson.waterwheel.nextBucketIsVideo, true);
    const waterwheelQueueRow = statusJson.automationQueue.rows.find((row) => row.area === "水车水桶");
    assert.equal(waterwheelQueueRow?.pending, 0);
    assert.match(waterwheelQueueRow?.status || "", /账号已关闭领取水车水桶/);
    assert.match(waterwheelQueueRow?.rule || "", /仅同步水车状态，不调用 skip\/recv/);
    assert.match(statusJson.waterwheel.autoReceiveRule, /do not call gs\.waterwheel\.skip or gs\.waterwheel\.recv/);
    const skipLog = logs
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find((entry) => entry?.step === "waterwheelReceiveSkip");
    assert.equal(skipLog?.reason, "profile-setting-disabled");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle exposes configured-on but effective-off waterwheel state when runtime env is disabled", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-runtime-disabled-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-runtime-disabled-cycle-test=${Date.now()}`
    );
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 0;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(sync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.recv" || item.iface === "gs.waterwheel.skip")
        .map((item) => item.iface),
      [],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterwheel.configuredAutoReceiveEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveAutoReceiveEnabled, false);
    assert.equal(statusJson.waterwheel.autoReceiveEnabled, false);
    assert.equal(statusJson.waterwheel.configuredSkipVideoBucketsEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveSkipVideoBucketsEnabled, false);
    assert.equal(statusJson.waterwheel.skipVideoBucketsEnabled, false);
    assert.equal(statusJson.waterwheel.autoReceiveSettingSource, "profile-setting");
    assert.equal(statusJson.waterwheel.autoReceiveDisabledReason, "runtime-disabled");
    assert.deepEqual(statusJson.waterwheel.pendingWaterwheelActions, []);
    const waterwheelQueueRow = statusJson.automationQueue.rows.find((row) => row.area === "水车水桶");
    assert.equal(waterwheelQueueRow?.pending, 0);
    assert.match(waterwheelQueueRow?.status || "", /AUTO_HANDLE_WATERWHEEL 已关闭/);
    assert.match(waterwheelQueueRow?.rule || "", /仅同步水车状态，不调用 skip\/recv/);
    assert.match(statusJson.waterwheel.autoReceiveRule, /do not call gs\.waterwheel\.skip or gs\.waterwheel\.recv/);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")), {
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: true,
    });
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle retains a video waterwheel bucket when the profile child switch is disabled", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-video-profile-retained-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: false,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-video-profile-retained-cycle-test=${Date.now()}`
    );
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 0;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(sync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: sync.waterwheel });
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.recv" || item.iface === "gs.waterwheel.skip")
        .map((item) => item.iface),
      [],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 0);
    assert.equal(statusJson.waterwheel.configuredAutoReceiveEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveAutoReceiveEnabled, true);
    assert.equal(statusJson.waterwheel.autoReceiveEnabled, true);
    assert.equal(statusJson.waterwheel.configuredSkipVideoBucketsEnabled, false);
    assert.equal(statusJson.waterwheel.effectiveSkipVideoBucketsEnabled, false);
    assert.equal(statusJson.waterwheel.skipVideoBucketsEnabled, false);
    assert.deepEqual(statusJson.waterwheel.pendingWaterwheelActions, []);
    assert.equal(statusJson.waterwheel.reason, "next-bucket-video-retained");
    const waterwheelQueueRow = statusJson.automationQueue.rows.find((row) => row.area === "水车水桶");
    assert.equal(waterwheelQueueRow?.pending, 0);
    assert.match(waterwheelQueueRow?.status || "", /保留不领取/);
    assert.match(waterwheelQueueRow?.rule || "", /保留视频桶/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle receives a video bucket base reward in strict skip then recv order", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-video-base-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    WATERWHEEL_MAX_RECEIVES_PER_CYCLE: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-video-base-cycle-test=${Date.now()}`
    );
    const requestLog = [];
    let waterDrops = 0;
    let waterwheel = { count: 2, advList: [3] };
    const makeCurrentSync = () => {
      const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentSync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.skip") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          waterDrops = 5;
          waterwheel = { count: 3, advList: [3] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: { oi: { bd: { [ITEM_IDS.WATER_DROP]: waterDrops } } },
            waterwheel,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.skip" || item.iface === "gs.waterwheel.recv")
        .map((item) => ({ iface: item.iface, args: item.args })),
      [
        { iface: "gs.waterwheel.skip", args: {} },
        { iface: "gs.waterwheel.recv", args: {} },
      ],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 1);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 1);
    assert.equal(statusJson.summary.waterwheelNormalReceivedCount, 0);
    assert.equal(statusJson.summary.waterwheelVideoBaseReceivedCount, 1);
    assert.equal(statusJson.waterwheel.receivedCount, 1);
    assert.equal(statusJson.waterwheel.normalReceivedCount, 0);
    assert.equal(statusJson.waterwheel.videoBaseReceivedCount, 1);
    const parsedLogs = logs.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const cycleSummary = parsedLogs.find((entry) => entry.step === "cycleSummary");
    assert.deepEqual(
      {
        type: cycleSummary.waterwheelActions[0].type,
        nextBucketWasVideo: cycleSummary.waterwheelActions[0].nextBucketWasVideo,
        receivedWaterDropCount: cycleSummary.waterwheelActions[0].receivedWaterDropCount,
      },
      {
        type: "receiveWaterwheelVideoBucketBase",
        nextBucketWasVideo: true,
        receivedWaterDropCount: 5,
      },
    );
    assert.equal(
      parsedLogs.some((entry) => entry.step === "waterwheelWaterDeltaOutOfExpectedRange"),
      false,
    );
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not recv when video bucket skip fails", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-video-skip-fail-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    WATERWHEEL_MAX_RECEIVES_PER_CYCLE: "8",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-video-skip-fail-cycle-test=${Date.now()}`
    );
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 0;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(sync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: sync.waterwheel });
        if (iface === "gs.waterwheel.skip") throw new Error("video bucket skip failed");
        if (iface === "gs.waterwheel.recv") throw new Error("recv must not run after skip failure");
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.skip" || item.iface === "gs.waterwheel.recv")
        .map((item) => item.iface),
      ["gs.waterwheel.skip"],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 1);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.waterwheel.configuredSkipVideoBucketsEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveSkipVideoBucketsEnabled, true);
    assert.equal(statusJson.waterwheel.skipVideoBucketsEnabled, true);
    assert.deepEqual(statusJson.waterwheel.pendingWaterwheelActions, [{
      type: "receiveWaterwheelVideoBucketBase",
      nextBucketNo: 3,
      steps: [
        { stage: "skip-video-requirement", iface: "gs.waterwheel.skip", args: {} },
        { stage: "receive-base-reward", iface: "gs.waterwheel.recv", args: {} },
      ],
    }]);
    const waterwheelQueueRow = statusJson.automationQueue.rows.find((row) => row.area === "水车水桶");
    assert.equal(waterwheelQueueRow?.pending, 1);
    assert.match(waterwheelQueueRow?.status || "", /跳过视频并领取当前桶基础水滴/);
    assert.match(waterwheelQueueRow?.rule || "", /跳过视频并领取基础水滴/);
    const errorLog = logs
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find((entry) => entry?.step === "waterwheelReceiveError");
    assert.equal(errorLog?.failureStage, "skip-video-requirement");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle stops the cycle action after video bucket recv fails without repeating skip", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-video-recv-fail-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    WATERWHEEL_MAX_RECEIVES_PER_CYCLE: "8",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-video-recv-fail-cycle-test=${Date.now()}`
    );
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 0;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(sync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: sync.waterwheel });
        if (iface === "gs.waterwheel.skip") return raw({ waterwheel: sync.waterwheel });
        if (iface === "gs.waterwheel.recv") throw new Error("video bucket recv failed");
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.skip" || item.iface === "gs.waterwheel.recv")
        .map((item) => item.iface),
      ["gs.waterwheel.skip", "gs.waterwheel.recv"],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 1);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    const errorLog = logs
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .find((entry) => entry?.step === "waterwheelReceiveError");
    assert.equal(errorLog?.failureStage, "receive-base-reward");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle rechecks the parent switch after waterwheel enter before sending skip or recv", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-parent-disabled-after-enter-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    WATERWHEEL_MAX_RECEIVES_PER_CYCLE: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-parent-disabled-after-enter=${Date.now()}`
    );
    const requestLog = [];
    let waterDrops = 0;
    let waterwheel = { count: 2, advList: [3] };
    const makeCurrentSync = () => {
      const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentSync);
        if (iface === "gs.waterwheel.enter") {
          fs.writeFileSync(settingsPath, JSON.stringify({
            autoReceiveWaterwheelBuckets: false,
            skipWaterwheelVideoBuckets: true,
          }), "utf8");
          return raw({ waterwheel });
        }
        if (iface === "gs.waterwheel.skip") return raw({ waterwheel });
        if (iface === "gs.waterwheel.recv") {
          waterDrops = 5;
          waterwheel = { count: 3, advList: [3] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: { oi: { bd: { [ITEM_IDS.WATER_DROP]: waterDrops } } },
            waterwheel,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.skip" || item.iface === "gs.waterwheel.recv")
        .map((item) => item.iface),
      [],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterwheelActionCount, 0);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle stops after video skip when the parent switch is disabled before recv", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-waterwheel-parent-disabled-after-skip-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_WATERWHEEL: "1",
    WATERWHEEL_MAX_RECEIVES_PER_CYCLE: "8",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?waterwheel-parent-disabled-after-skip=${Date.now()}`
    );
    const requestLog = [];
    let waterDrops = 0;
    let waterwheel = { count: 2, advList: [3] };
    const makeCurrentSync = () => {
      const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.waterwheel = waterwheel;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentSync);
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel });
        if (iface === "gs.waterwheel.skip") {
          fs.writeFileSync(settingsPath, JSON.stringify({
            autoReceiveWaterwheelBuckets: false,
            skipWaterwheelVideoBuckets: true,
          }), "utf8");
          return raw({ waterwheel });
        }
        if (iface === "gs.waterwheel.recv") {
          waterDrops = 5;
          waterwheel = { count: 3, advList: [3] };
          currentSync = makeCurrentSync();
          return raw({
            $usrTot: { oi: { bd: { [ITEM_IDS.WATER_DROP]: waterDrops } } },
            waterwheel,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface === "gs.waterwheel.skip" || item.iface === "gs.waterwheel.recv")
        .map((item) => item.iface),
      ["gs.waterwheel.skip"],
    );
    const parsedLogs = logs.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const cycleSummary = parsedLogs.find((entry) => entry.step === "cycleSummary");
    assert.equal(cycleSummary.waterwheelActionCount, 1);
    assert.equal(cycleSummary.waterwheelReceivedCount, 0);
    assert.deepEqual(
      {
        failed: cycleSummary.waterwheelActions[0].failed ?? false,
        stoppedReason: cycleSummary.waterwheelActions[0].stoppedReason,
        stoppedStage: cycleSummary.waterwheelActions[0].stoppedStage,
      },
      {
        failed: false,
        stoppedReason: "profile-setting-disabled",
        stoppedStage: "receive-base-reward",
      },
    );
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick rethrows websocket heart tick timeouts for reconnect", async () => {
  const oldEnv = { ...process.env };
  assignCycleEnv({
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
  });

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?wait-heart-timeout-test=${Date.now()}`);
    let now = 1000;
    const ws = {
      async request(iface) {
        if (iface === "gs.usr.heartTick") throw new Error("WS request timeout gs.usr.heartTick");
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await assert.rejects(
      () => waitWithOnlineHeartTick(ws, "test-token", { marker: "sync" }, 16, {
        cycle: 7,
        nowFn: () => now,
        waitFn: async (ms) => {
          now += Math.max(1, Math.floor(ms));
        },
        statusRefreshIntervalMs: 50,
        customerOrderRefresher: async (wsArg, tokenArg, syncValue) => syncValue,
      }),
      /WS request timeout gs\.usr\.heartTick/,
    );
  } finally {
    process.env = oldEnv;
  }
});

test("reopenGameWsSessionWithRetry retries one transient failure with backoff and refreshes truth", async () => {
  const { reopenGameWsSessionWithRetry } = await import(`./inspect-garden-dryrun.mjs?reconnect-retry-test=${Date.now()}`);
  let closed = false;
  let attempts = 0;
  const waits = [];
  let nowMs = 0;
  let refreshCount = 0;
  const result = await reopenGameWsSessionWithRetry({
    ws: {
      close() {
        closed = true;
      },
    },
    gsInfo: { idx: 730 },
    gsLoginArg: { token: "old-token" },
    syncValue: { marker: "old-sync" },
    cycle: 9,
    reason: "WS request timeout gs.usrLand.refresh",
    reconnectJitterRatio: 0,
    waitFn: async (ms) => {
      waits.push(ms);
      nowMs += ms;
    },
    delayNowFn: () => nowMs,
    openSession: async () => {
      attempts++;
      if (attempts === 1) throw new Error("WS connect timeout wss://example");
      return {
        ws: { marker: "new-ws" },
        gsToken: "new-token",
        syncValue: { marker: "new-sync" },
      };
    },
    refreshLandFn: async (ws, gsToken, syncValue) => {
      refreshCount++;
      return { ...syncValue, refreshed: true };
    },
  });

  assert.equal(closed, true);
  assert.equal(attempts, 2);
  assert.equal(refreshCount, 1);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(result, {
    ws: { marker: "new-ws" },
    gsToken: "new-token",
    syncValue: { marker: "new-sync", refreshed: true },
  });
});

test("reconnect uses the bounded default backoff instead of the legacy fixed delay", async () => {
  const { reopenGameWsSessionWithRetry } = await import(
    `./inspect-garden-dryrun.mjs?reconnect-immediate-test=${Date.now()}`
  );
  let attempts = 0;
  const waits = [];
  let nowMs = 0;
  const oldValue = process.env.WS_RECONNECT_RETRY_SECONDS;
  process.env.WS_RECONNECT_RETRY_SECONDS = "30";
  try {
    const result = await reopenGameWsSessionWithRetry({
      ws: { close() {} },
      gsInfo: { idx: 730 },
      gsLoginArg: { token: "old-token" },
      syncValue: { marker: "old-sync" },
      reconnectJitterRatio: 0,
      waitFn: async (milliseconds) => {
        waits.push(milliseconds);
        nowMs += milliseconds;
      },
      delayNowFn: () => nowMs,
      openSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("first connect failed");
        return {
          ws: { marker: "new-ws" },
          gsToken: "new-token",
          syncValue: { marker: "new-sync" },
        };
      },
      refreshLandFn: async (_ws, _token, syncValue) => syncValue,
    });

    assert.equal(attempts, 2);
    assert.deepEqual(waits, [2000]);
    assert.equal(result.gsToken, "new-token");
  } finally {
    if (oldValue == null) delete process.env.WS_RECONNECT_RETRY_SECONDS;
    else process.env.WS_RECONNECT_RETRY_SECONDS = oldValue;
  }
});

test("reconnect stops after five failed connect attempts with bounded backoff", async () => {
  const { reopenGameWsSessionWithRetry } = await import(
    `./inspect-garden-dryrun.mjs?reconnect-attempt-limit-test=${Date.now()}`
  );
  let attempts = 0;
  const waits = [];
  let nowMs = 0;

  await assert.rejects(
    () => reopenGameWsSessionWithRetry({
      ws: { close() {} },
      gsInfo: { idx: 730 },
      gsLoginArg: { token: "old-token" },
      syncValue: { marker: "old-sync" },
      reconnectJitterRatio: 0,
      waitFn: async (milliseconds) => {
        waits.push(milliseconds);
        nowMs += milliseconds;
      },
      delayNowFn: () => nowMs,
      openSession: async () => {
        attempts += 1;
        throw new Error(`connect failed ${attempts}`);
      },
      refreshLandFn: async (_ws, _token, syncValue) => syncValue,
    }),
    /connect failed 5/,
  );

  assert.equal(attempts, 5);
  assert.deepEqual(waits, [2000, 5000, 10000, 30000]);
});

test("refreshStatusSnapshot rethrows websocket failures before issuing another request", async () => {
  const { refreshStatusSnapshot } = await import(
    `./inspect-garden-dryrun.mjs?status-snapshot-ws-failure=${Date.now()}`
  );
  const requests = [];
  const ws = {
    async request(iface) {
      requests.push(iface);
      throw new Error(`WS closed while waiting for ${iface}`);
    },
  };

  await assert.rejects(
    () => refreshStatusSnapshot(ws, "test-token", { marker: "sync" }, "testStatus"),
    /WS closed while waiting for gs\.usr\.lazySync/,
  );
  assert.deepEqual(requests, ["gs.usr.lazySync"]);
});

test("GameWs rejects pending requests on socket close and clears their timers", async () => {
  const previousWebSocket = globalThis.WebSocket;
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      super();
      this.readyState = FakeWebSocket.CONNECTING;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    send() {}

    close() {
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  try {
    const { GameWs } = await import(
      `./inspect-garden-dryrun.mjs?game-ws-close-test=${Date.now()}`
    );
    const ws = new GameWs("ws://test", { requestTimeoutMs: 1000 });
    await ws.connect();
    const pending = ws.request("gs.orderTeam.submitOrder", {});
    ws.close();
    await assert.rejects(
      pending,
      /WS closed while waiting for gs\.orderTeam\.submitOrder/,
    );
    assert.equal(ws.pending.size, 0);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("GameWs rejects requests immediately when the socket is already closed", async () => {
  const previousWebSocket = globalThis.WebSocket;
  class ClosedWebSocket extends EventTarget {
    static OPEN = 1;
    static CLOSED = 3;

    constructor() {
      super();
      this.readyState = ClosedWebSocket.OPEN;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send() {
      assert.fail("send must not run for a closed socket");
    }

    close() {
      this.readyState = ClosedWebSocket.CLOSED;
      this.dispatchEvent(new Event("close"));
    }
  }
  globalThis.WebSocket = ClosedWebSocket;
  try {
    const { GameWs } = await import(
      `./inspect-garden-dryrun.mjs?game-ws-already-closed=${Date.now()}`
    );
    const ws = new GameWs("ws://test");
    await ws.connect();
    ws.close();

    await assert.rejects(
      ws.request("gs.usrLand.refresh", {}),
      /WebSocket is not open: gs\.usrLand\.refresh/,
    );
    assert.equal(ws.pending.size, 0);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("GameWs times out unanswered requests and removes them from pending", async () => {
  const previousWebSocket = globalThis.WebSocket;
  class SilentWebSocket extends EventTarget {
    static OPEN = 1;

    constructor() {
      super();
      this.readyState = SilentWebSocket.OPEN;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send() {}

    close() {}
  }
  globalThis.WebSocket = SilentWebSocket;
  try {
    const { GameWs } = await import(
      `./inspect-garden-dryrun.mjs?game-ws-request-timeout=${Date.now()}`
    );
    const ws = new GameWs("ws://test", { requestTimeoutMs: 10 });
    await ws.connect();

    await assert.rejects(
      ws.request("gs.usrLand.refresh", {}),
      /WS request timeout gs\.usrLand\.refresh/,
    );
    assert.equal(ws.pending.size, 0);
  } finally {
    globalThis.WebSocket = previousWebSocket;
  }
});

test("socket close and error while a request is pending are classified as recoverable network failures", async () => {
  const { classifyAutomationError } = await import(
    `./inspect-garden-dryrun.mjs?game-ws-classify-test=${Date.now()}`
  );

  for (const message of [
    "WS closed while waiting for gs.orderTeam.submitOrder",
    "WS error while waiting for gs.orderTeam.refreshOrder",
  ]) {
    const classified = classifyAutomationError(new Error(message));
    assert.equal(classified.category, "network", message);
    assert.equal(classified.exitCode, 1, message);
  }
});

test("team-order runtime context uses the real flower names and client noble-card rule", async () => {
  const { buildTeamOrderRunnerContext } = await import(
    `./inspect-garden-dryrun.mjs?team-order-context-test=${Date.now()}`
  );
  assert.equal(typeof buildTeamOrderRunnerContext, "function");

  const context = buildTeamOrderRunnerContext({
    rchgTot: {
      cardMap: {
        1: { type: 1, isMain: true },
      },
    },
  }, {
    nobleExpAdd: 0.25,
  }, {
    trigger: "test",
  });

  assert.equal(context.flowerNames[23_001], "白百合");
  assert.equal(context.nobleExpAdd, 0.25);
  assert.equal(context.trigger, "test");
});

test("resolveGatewayServerIndex requires gateway lastGsIdx and never falls back to default server", async () => {
  const { resolveGatewayServerIndex } = await import(`./inspect-garden-dryrun.mjs?server-index-test=${Date.now()}`);

  assert.equal(resolveGatewayServerIndex({ acc: { lastGsIdx: 726 } }), 726);
  assert.throws(
    () => resolveGatewayServerIndex({ acc: {} }),
    /账号信息缺少区服/,
  );
});

test("waitWithOnlineHeartTick rethrows expired session status refresh errors", async () => {
  const oldEnv = { ...process.env };
  assignCycleEnv({
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
  });

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?wait-session-expired-test=${Date.now()}`);
    let now = 1000;
    const ws = {
      async request(iface) {
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await assert.rejects(
      waitWithOnlineHeartTick(ws, "test-token", { marker: "sync" }, 16, {
        cycle: 8,
        nowFn: () => now,
        waitFn: async (ms) => {
          now += Math.max(1, Math.floor(ms));
        },
        statusRefreshIntervalMs: 5,
        statusRefresher: async () => {
          throw new Error('Land refresh failed: {"type":90000,"msg":"会话已过期，请重新登录"}');
        },
        statusWriter: () => {},
        customerOrderRefresher: async (wsArg, tokenArg, syncValue) => syncValue,
      }),
      /会话已过期/,
    );
  } finally {
    process.env = oldEnv;
  }
});

test("runGardenCycle rethrows websocket request timeouts instead of continuing on a stale connection", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ws-timeout-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-17T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cycle-ws-timeout-test=${Date.now()}`);
    const sync = makeSync({
      1001: {
        state: 2,
        flowerId: 23001,
        lvl: 2,
        nextTime: "2026-06-17T01:59:00.000Z",
      },
    }, 5);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usrLand.harvest") throw new Error("WS request timeout gs.usrLand.harvest");
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await assert.rejects(
      () => runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1),
      /WS request timeout gs\.usrLand\.harvest/,
    );
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plantBatch"), false);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.waterBatch"), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle isolates non-session action errors and continues later garden work", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-nonfatal-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T02:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?nonfatal-cycle-test=${Date.now()}`);
    const nearMature = {
      state: 2,
      flowerId: 23001,
      lvl: 2,
      nextTime: new Date(nowMs + 30_000).toISOString(),
      harvestCnt: 0,
    };
    const seeded = {
      state: 1,
      flowerId: 23001,
      lvl: 2,
      nextTime: new Date(nowMs + 90_000).toISOString(),
      harvestCnt: 0,
    };
    const growing = { ...seeded, state: 2 };
    let currentSync = makeSync({ 1001: nearMature, 1017: {} }, 3);
    currentSync.$usrTot.data.bag[7] = 5;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usrLand.speedUpFree") throw new Error("temporary speedUpFree backend error");
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          currentSync = makeSync({ 1001: nearMature, 1017: seeded }, 3);
          currentSync.$usrTot.data.bag[7] = 5;
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          currentSync = makeSync({ 1001: nearMature, 1017: growing }, 3);
          currentSync.$usrTot.data.bag[7] = 5;
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.water"), true);
    assert.equal(result.usrLandTot.usrLand.landMap[1017].state, 2);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 1);
    assert.equal(statusJson.summary.wateredCount, 1);
    assert.equal(statusJson.summary.cycleErrorCount >= 1, true);
    assert.match(statusJson.summary.cycleErrors[0].message, /speedUpFree/);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle stops pearl hires and refreshes sync when hire item is rejected by server", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-pearl-hire-item-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-22T08:30:00.000Z");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ pearlHireItemReserveCount: 6 }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "1",
    PEARL_CHECK_HIRE_STATE: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?pearl-hire-item-shortage-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    sync.$usrTot.data.bag[1003] = 7;
    sync.pearlTot = {
      pearl: {
        recvDailyDate: new Date(nowMs).toISOString(),
      },
      placeMap: {
        1: { placeId: 1 },
        2: { placeId: 2 },
      },
      recommendList: [7001, 7002],
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  1003: 0,
                },
              },
            },
          });
        }
        if (iface === "gs.pearlPlace.hire") {
          return { m: { code: 301, param: { iid: 1003 } } };
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.pearlPlace.hire").length, 1);
    assert.equal(requestLog.some((item) => item.iface === "gs.usr.lazySync"), true);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.pearl.hireItemCount, 0);
    assert.equal(statusJson.summary.pearlHireCount, 0);
    assert.equal(statusJson.summary.cycleErrors.some((item) => /Pearl hire failed/.test(item.message)), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps one hundred pearl hire items when legacy settings omit the reserve", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-pearl-default-reserve-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-22T08:30:00.000Z");
  Date.now = () => nowMs;
  delete process.env.PROFILE_SETTINGS_PATH;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "1",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?pearl-default-reserve-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    sync.$usrTot.data.bag[1003] = 100;
    sync.pearlTot = {
      pearl: { recvDailyDate: new Date(nowMs).toISOString() },
      placeMap: { 1: { placeId: 1 } },
      recommendList: [7001],
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.pearlPlace.hire"), false);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.match(statusJson.pearl.autoHandleRule, /greater than 100/);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle harvests flowers that become mature after watering in the same cycle", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cycle-test=${Date.now()}`);
    const requestLog = [];
    const planted = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T00:01:00.000Z", harvestCnt: 0 };
    const mature = { ...planted, state: 3, nextTime: "2026-06-16T00:00:00.000Z" };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          const seenWater = requestLog.some((item) => item.iface === "gs.usrLand.water");
          const seenPlant = requestLog.some((item) => item.iface === "gs.usrLand.plant");
          const seenHarvest = requestLog.some((item) => item.iface === "gs.usrLand.harvest");
          return raw(makeSync({ 1001: seenHarvest ? {} : seenWater ? mature : seenPlant ? planted : {} }, seenHarvest ? 1 : 0));
        }
        if (iface === "gs.usr.heartTick") {
          return raw({});
        }
        if (iface === "gs.usr.lazySync") {
          return raw({});
        }
        if (iface === "gs.usrLand.plant") {
          return raw(makeSync({ 1001: planted }));
        }
        if (iface === "gs.usrLand.water") {
          return raw(makeSync({ 1001: mature }));
        }
        if (iface === "gs.usrLand.harvest") {
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  23001: 1,
                },
              },
            },
            usrLandTot: {
              chgLandMap: {
                [args.landId]: {},
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", makeSync({ 1001: {} }), 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.usrLand.plant",
        "gs.usrLand.refresh",
        "gs.usrLand.water",
        "gs.usrLand.refresh",
        "gs.usrLand.harvest",
        "gs.usrLand.refresh",
      ],
    );
    assert.deepEqual(result.usrLandTot.usrLand.landMap[1001], {});
    assert.equal(result.$usrTot.data.bag[23001], 1);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle rechecks free speed-up after mid-cycle actions even without watering", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-mid-action-speedup-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const baseMs = Date.parse("2026-06-17T01:00:00.000Z");
  let nowMs = baseMs;
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "1",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?mid-action-speedup-cycle-test=${Date.now()}`);
    const growing = {
      state: 2,
      flowerId: 23001,
      lvl: 2,
      nextTime: new Date(baseMs + 90_000).toISOString(),
      harvestCnt: 0,
    };
    const mature = {
      ...growing,
      state: 3,
      nextTime: new Date(baseMs + 45_000).toISOString(),
    };
    let currentSync = makeSync({ 1001: growing }, 0);
    currentSync.$usrTot.data.bag[7] = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.shopCultivate.enter") {
          nowMs = baseMs + 45_000;
          return raw({
            shopCultivate: {
              infoMap: {},
              bRecord: {},
            },
          });
        }
        if (iface === "gs.usrLand.speedUpFree") {
          currentSync = makeSync({ 1001: mature }, 0);
          currentSync.$usrTot.data.bag[7] = 0;
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.harvest") {
          currentSync = makeSync({ 1001: {} }, 1);
          currentSync.$usrTot.data.bag[7] = 0;
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  23001: 1,
                },
              },
            },
            usrLandTot: {
              chgLandMap: {
                [args.landId]: {},
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.shopCultivate.enter",
        "gs.usrLand.speedUpFree",
        "gs.usrLand.refresh",
        "gs.usrLand.harvest",
        "gs.usrLand.refresh",
      ],
    );
    assert.deepEqual(result.usrLandTot.usrLand.landMap[1001], {});
    assert.equal(result.$usrTot.data.bag[23001], 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.speedUpFree, true);
    assert.equal(statusJson.summary.harvestedCount, 1);
    assert.equal(statusJson.summary.postWaterSpeedUpFree, true);
    assert.equal(statusJson.summary.postWaterHarvestedCount, 1);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle generates customer orders before deciding there are no customer orders", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = makeSync({}, 0);
    baseSync.$usrTot.cntMap = {
      107: { type: 107, tdyCnt: 0 },
    };
    const authorityNowMs = Date.now();
    baseSync.$timeAuthority = {
      version: 1,
      lastAcceptedSample: {
        serverMs: authorityNowMs,
        correctedServerMs: authorityNowMs,
        requestStartedAtMs: authorityNowMs,
        responseAtMs: authorityNowMs,
        rttMs: 0,
        serverOffsetMs: 0,
        acceptedAtMs: authorityNowMs,
      },
      sampleMaxAgeMs: 120_000,
    };
    baseSync.videoDouble = {
      videoCnt: 1,
      eTime: "2099-01-01T00:00:00.000Z",
    };
    baseSync.$usrTot.data.bag[300101] = 3;
    const generatedOrderSync = {
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            501: {
              artId: 300101,
              num: 3,
              cTime: "2026-06-16T00:00:00.000Z",
            },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      { orderCustomerNpcConfig: customerNpcConfigForTest([4, 8], "fixture:customer-cycle-test") },
    );

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.orderCustomer.genOrder",
        "gs.orderCustomer.finishOrder",
      ],
    );
    assert.deepEqual(requestLog.find((item) => item.iface === "gs.orderCustomer.genOrder").args, { guestNpcIdList: [] });
    assert.deepEqual(requestLog.find((item) => item.iface === "gs.orderCustomer.finishOrder").args, { npcId: 501 });

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.runHistory.customerOrderSubmissions[0].outcome, "completed");
    assert.equal(statusJson.runHistory.customerOrderSubmissions[0].outcomeText, "完成订单");
    const statusMd = fs.readFileSync(path.join(outDir, "garden-status.md"), "utf8");
    const statusHtml = fs.readFileSync(path.join(outDir, "garden-status.html"), "utf8");
    assert.doesNotMatch(statusHtml, /<details\b/);
    assert.doesNotMatch(statusHtml, /<summary\b/);
    assert.match(statusMd, /顾客订单处理记录/);
    assert.match(statusMd, /完成订单/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps generating customer orders when existing orders do not fill the customer limit", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-fill-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-fill-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseOrder = {
      artId: 399999,
      num: 1,
      cTime: "2026-06-16T00:00:00.000Z",
    };
    const baseSync = {
      ...makeSync({}, 0),
      $timeAuthority: makeTrustedTimeAuthority(),
      videoDouble: {
        videoCnt: 1,
        eTime: "2099-01-01T00:00:00.000Z",
      },
      $usrTot: {
        data: {
          bag: {
            23001: 1,
            23002: 1,
            23003: 1,
          },
        },
        cntMap: {
          107: { type: 107, tdyCnt: 0 },
        },
      },
      flowerArtTot: {
        flowerArt: {
          makeList: [],
        },
      },
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            1: baseOrder,
          },
        },
      },
    };
    const generatedOrderSync = {
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            1: baseOrder,
            4: baseOrder,
            6: baseOrder,
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      { orderCustomerNpcConfig: customerNpcConfigForTest([1, 4, 6], "fixture:customer-fill-cycle-test") },
    );

    assert.deepEqual(requestLog.find((item) => item.iface === "gs.orderCustomer.genOrder").args, { guestNpcIdList: [] });
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle fails closed when customer NPC unlock state is missing", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-infer-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-infer-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseOrder = {
      artId: 399999,
      num: 1,
      cTime: "2026-06-16T00:00:00.000Z",
    };
    const baseSync = {
      ...makeSync({}, 0),
      $timeAuthority: makeTrustedTimeAuthority(),
      videoDouble: {
        videoCnt: 1,
        eTime: "2099-01-01T00:00:00.000Z",
      },
      $usrTot: {
        data: {
          bag: {
            23001: 1,
            23002: 1,
            23003: 1,
          },
        },
        cntMap: {
          107: { type: 107, tdyCnt: 0 },
        },
      },
      flowerArtTot: {
        flowerArt: {
          makeList: [],
        },
      },
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            2: baseOrder,
          },
        },
      },
    };
    const generatedOrderSync = {
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            2: baseOrder,
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      {
        orderCustomerNpcConfig: {
          ...customerNpcConfigForTest([1, 2, 3], "fixture:customer-infer-cycle-test"),
          npcs: {
            1: { id: 1, maintaskId: 1 },
            2: { id: 2, maintaskId: 2 },
            3: { id: 3, maintaskId: 3 },
          },
        },
      },
    );

    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.genOrder"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), false);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle skips customer order generation while nextGenTime is cooling down", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-cooldown-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T10:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-cooldown-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = {
      ...makeSync({}, 0),
      orderCustomerTot: {
        orderCustomer: {
          nextGenTime: "2026-06-16T10:05:00.000Z",
          orderMap: {},
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
      ],
    );
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.genOrder"), false);
  } finally {
    process.env = oldEnv;
    Date.now = oldNow;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle handles a customer-order due event at a later serial cycle boundary", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-due-event-"));
  const oldEnv = { ...process.env };
  const startMs = Date.now();
  let nowMs = startMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-due-event-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = makeSync({}, 0);
    baseSync.$timeAuthority = makeTrustedTimeAuthority(startMs);
    baseSync.$usrTot.cntMap = {
      107: { type: 107, tdyCnt: 0 },
    };
    baseSync.videoDouble = {
      videoCnt: 1,
      eTime: "2099-01-01T00:00:00.000Z",
    };
    baseSync.$usrTot.data.bag[300101] = 3;
    baseSync.orderCustomerTot = {
      orderCustomer: {
        nextGenTime: new Date(startMs).toISOString(),
        orderMap: {},
      },
    };
    const generatedOrderSync = {
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            501: {
              artId: 300101,
              num: 3,
              cTime: "2026-06-16T00:00:00.000Z",
            },
          },
        },
      },
    };
    baseSync.$usrTot.cntMap = {
      107: { type: 107, tdyCnt: 0 },
    };
    const innerScheduler = createCustomerOrderScheduler({ nowFn: () => nowMs });
    let firstCustomerDecision = true;
    const customerOrderScheduler = {
      observeSync: innerScheduler.observeSync,
      evaluate(args) {
        const result = innerScheduler.evaluate(args);
        if (firstCustomerDecision) {
          firstCustomerDecision = false;
          nowMs = startMs + 2_000;
        }
        return result;
      },
      dueInMs: innerScheduler.dueInMs,
      beginGeneration: innerScheduler.beginGeneration,
      completeGeneration: innerScheduler.completeGeneration,
      failGeneration: innerScheduler.failGeneration,
      recordAction: innerScheduler.recordAction,
      snapshot: innerScheduler.snapshot,
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args, atMs: nowMs });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      {
        customerOrderScheduler,
        nowFn: () => nowMs,
        orderCustomerNpcConfig: customerNpcConfigForTest([4, 8], "fixture:customer-due-event-test"),
      },
    );

    const generationCalls = requestLog.filter((item) => item.iface === "gs.orderCustomer.genOrder");
    assert.equal(generationCalls.length, 1);
    assert.equal(generationCalls[0].atMs, startMs + 2_000);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), true);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps refreshed inactive flower art list when customer order generation returns partial flower art data", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-art-activation-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-art-activation-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = {
      ...makeSync({}, 0),
      $timeAuthority: makeTrustedTimeAuthority(),
      videoDouble: {
        videoCnt: 1,
        eTime: "2099-01-01T00:00:00.000Z",
      },
      $usrTot: {
        data: {
          bag: {
            300101: 1,
            23001: 1,
            23002: 1,
            23003: 1,
          },
        },
        cntMap: {
          107: { type: 107, tdyCnt: 0 },
        },
      },
      flowerArtTot: {
        flowerArt: {
          makeList: [300101],
        },
      },
    };
    const refreshedActivationSync = {
      flowerArtTot: {
        flowerArt: {
          makeList: [],
          uTime: "2026-06-16T00:00:00.000Z",
        },
      },
    };
    const generatedOrderSync = {
      flowerArtTot: {
        flowerArt: {
          uTime: "2026-06-16T00:00:01.000Z",
        },
      },
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            501: {
              artId: 300101,
              num: 1,
              cTime: "2026-06-16T00:00:00.000Z",
            },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(refreshedActivationSync);
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    const teamOrderCapability = {
      ready: true,
      enabled: true,
      realValidated: true,
      teamOrderTriggerProtectionEnabled: false,
    };
    const teamOrderRuntime = {
      config: {
        durationSeconds: 50,
        maxOrderNum: 160,
        refreshPerSecond: 4,
        orders: new Map(),
      },
      bind() {},
      capability() {
        return teamOrderCapability;
      },
      async handle(currentSync) {
        return {
          syncValue: currentSync,
          handled: false,
          finalReason: "idle",
        };
      },
      takeFatalError() {
        return null;
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      {
        teamOrderRuntime,
        orderCustomerNpcConfig: customerNpcConfigForTest([4, 8], "customer-art-activation-test"),
      },
    );

    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.flowerArt.makeFlowerArt"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), true);

    const orderStatusJson = JSON.parse(fs.readFileSync(path.join(outDir, "order-status.json"), "utf8"));
    assert.equal(orderStatusJson.customer.config.artActivationKnown, true);
    assert.equal(orderStatusJson.customer.config.activeArtCount, 0);
    assert.equal(orderStatusJson.customer.orders[0].status, "temporary-out-of-stock");
    assert.match(orderStatusJson.customer.orders[0].actionText, /暂时没货/);
    assert.equal(orderStatusJson.residentBoard.teamOrderOfflineReady, true);
    assert.equal(orderStatusJson.residentBoard.teamOrderRealValidated, true);
    assert.equal(orderStatusJson.residentBoard.teamOrderTriggerProtectionEnabled, false);
    assert.equal(orderStatusJson.residentBoard.teamOrderReady, true);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle finishes customer order in the same event after authoritative make confirmation", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-make-wait-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-make-wait-cycle-test=${Date.now()}`);
    const bag = {
      7: 99,
      300101: 0,
      3061: 99,
    };
    for (let itemId = 23000; itemId < 24000; itemId++) {
      bag[itemId] = 99;
    }
    const sync = {
      $usrTot: {
        data: {
          bag,
        },
      },
      rchgTot: {
        cardMap: {},
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
            8: { artId: 300101, num: 3, cTime: "2026-06-16T01:50:00.000Z" },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.flowerArt.makeFlowerArt") {
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  300101: 3,
                },
              },
            },
          });
        }
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.flowerArt.makeFlowerArt"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), true);
    assert.equal(result.$usrTot.data.bag[300101], 0);
    assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.runHistory.customerOrderSubmissions.at(-1).outcome, "completed");
    assert.equal(statusJson.runHistory.customerOrderSubmissions.at(-1).makeToFinishDelayMs, 0);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle locally deducts customer flower art after finishing order when response omits item deltas", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-finish-local-items-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-finish-local-items-test=${Date.now()}`);
    const sync = {
      $usrTot: {
        data: {
          bag: {
            7: 99,
            300101: 3,
          },
        },
      },
      rchgTot: {
        cardMap: {},
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
            8: { artId: 300101, num: 3, cTime: "2026-06-16T01:50:00.000Z" },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), true);
    assert.equal(result.$usrTot.data.bag[300101], 0);
    assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.flowerArtInventory.rows.some((row) => row.artId === 300101), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle finishes same-event customer art without duplicating itemAddChg and oi.bi", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-make-oi-bi-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-make-oi-bi-cycle-test=${Date.now()}`);
    const bag = {
      7: 99,
      300101: 0,
      3061: 99,
    };
    for (let itemId = 23000; itemId < 24000; itemId++) {
      bag[itemId] = 99;
    }
    const initialSync = {
      $usrTot: {
        data: {
          bag,
        },
      },
      rchgTot: {
        cardMap: {},
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
            8: { artId: 300101, num: 3, cTime: "2026-06-16T01:50:00.000Z" },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    };
    let serverSync = initialSync;
    let madeFlowerArt = false;
    let replayedMakeFlowerArtSync = false;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(serverSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          if (madeFlowerArt && !replayedMakeFlowerArtSync) {
            replayedMakeFlowerArtSync = true;
            return raw({
              $usrTot: {
                itemAddChg: {
                  itemMap: {
                    300101: 3,
                  },
                  itemAddRcdList: [
                    { itemMap: { 300101: 3 } },
                  ],
                },
                oi: {
                  bi: {
                    300101: 3,
                  },
                },
              },
            });
          }
          return raw({});
        }
        if (iface === "gs.flowerArt.makeFlowerArt") {
          madeFlowerArt = true;
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  300101: 3,
                },
                itemAddRcdList: [
                    { itemMap: { 300101: 3 } },
                ],
              },
              oi: {
                bi: {
                  300101: 3,
                },
              },
            },
          });
        }
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    const guardedWs = withDefaultExperienceLazySync(ws);

    const afterMake = await runGardenCycle(guardedWs, "test-token", initialSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.flowerArt.makeFlowerArt"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), true);
    assert.equal(afterMake.$usrTot.data.bag[300101], 0);
    assert.equal(afterMake.orderCustomerTot.orderCustomer.orderMap[8], undefined);
    const firstStatusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(firstStatusJson.flowerArtInventory.rows.some((row) => row.artId === 300101), false);

    const serverUsrTotAfterMake = { ...afterMake.$usrTot };
    delete serverUsrTotAfterMake.itemAddChg;
    delete serverUsrTotAfterMake.oi;
    serverSync = {
      ...afterMake,
      $usrTot: serverUsrTotAfterMake,
    };
    const finishCountBeforeSecondCycle = requestLog.filter((item) => item.iface === "gs.orderCustomer.finishOrder").length;
    const afterFinish = await runGardenCycle(guardedWs, "test-token", afterMake, 2);

    assert.equal(
      requestLog.filter((item) => item.iface === "gs.orderCustomer.finishOrder").length,
      finishCountBeforeSecondCycle,
    );
    assert.equal(afterFinish.$usrTot.data.bag[300101], 0);
    assert.equal(afterFinish.orderCustomerTot.orderCustomer.orderMap[8], undefined);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.flowerArtInventory.rows.some((row) => row.artId === 300101), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waits for customer flower art sync when make response omits confirmed item gain", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-make-stale-sync-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-make-stale-sync-test=${Date.now()}`);
    const bag = {
      7: 99,
      300101: 0,
      3061: 99,
    };
    for (let itemId = 23000; itemId < 24000; itemId++) {
      bag[itemId] = 99;
    }
    const sync = {
      $usrTot: {
        data: {
          bag,
        },
      },
      rchgTot: {
        cardMap: {},
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
            8: { artId: 300101, num: 3, cTime: "2026-06-16T01:50:00.000Z" },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    };
    let lazySyncCount = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          lazySyncCount += 1;
          return lazySyncCount === 1
            ? raw({})
            : raw({
              $usrTot: {
                data: {
                  bag: {
                    300101: 0,
                  },
                },
              },
            });
        }
        if (iface === "gs.flowerArt.makeFlowerArt") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.flowerArt.makeFlowerArt"), true);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), false);
    assert.equal(result.$usrTot.data.bag[300101], 0);
    assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8].artId, 300101);
    assert.deepEqual(result.orderCustomerTot.orderCustomer.orderMap[8].automationPendingArtSync, {
      artId: 300101,
      expectedCount: 3,
      reason: "make-flower-art-unconfirmed",
    });

    const orderStatusJson = JSON.parse(fs.readFileSync(path.join(outDir, "order-status.json"), "utf8"));
    assert.equal(orderStatusJson.customer.orders[0].status, "waiting-art-sync");
    assert.equal(orderStatusJson.customer.orders[0].statusText, "等待花艺库存同步");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle rejects lower-reward customer orders before a higher-reward finishOrder shortage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-301-isolated-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-finish-301-isolated-test=${Date.now()}`);
    const bag = {
      7: 99,
      300101: 3,
      300102: 0,
      3061: 99,
    };
    for (let itemId = 23000; itemId < 24000; itemId++) {
      bag[itemId] = 99;
    }
    const sync = {
      $usrTot: {
        data: {
          bag,
        },
      },
      rchgTot: {
        cardMap: {},
      },
      flowerArtTot: {
        flowerArt: {
          makeList: [300101, 300102],
        },
      },
      videoDouble: {
        eTime: "2026-06-16T02:05:00.000Z",
      },
      orderCustomerTot: {
        orderCustomer: {
          orderMap: {
            8: { artId: 300101, num: 3, cTime: "2026-06-16T01:50:00.000Z" },
            9: { artId: 300102, num: 2, cTime: "2026-06-16T01:51:00.000Z" },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    };
    const logs = [];
    const originalConsoleLog = console.log;
    console.log = (...args) => {
      logs.push(args.join(" "));
      originalConsoleLog(...args);
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderCustomer.finishOrder") {
          assert.deepEqual(args, { npcId: 8 });
          return { m: { code: 301, param: { iid: 300101 } } };
        }
        if (iface === "gs.orderCustomer.rejectOrder") {
          assert.deepEqual(args, { npcId: 9 });
          return raw({});
        }
        if (iface === "gs.flowerArt.makeFlowerArt") {
          assert.equal(args.num, 1);
          assert.equal(Array.isArray(args.flowersIds), true);
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  300102: 1,
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    try {
      await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);
    } finally {
      console.log = originalConsoleLog;
    }

    assert.deepEqual(
      requestLog
        .map((item) => item.iface)
        .filter((iface) => [
          "gs.orderCustomer.rejectOrder",
          "gs.orderCustomer.finishOrder",
          "gs.flowerArt.makeFlowerArt",
        ].includes(iface)),
      [
        "gs.orderCustomer.rejectOrder",
        "gs.orderCustomer.finishOrder",
      ],
    );
    assert.equal(requestLog.some((item) => item.iface === "gs.flowerArt.makeFlowerArt"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.rejectOrder"), true);
    assert.equal(logs.some((line) => line.includes("\"step\":\"customerOrderActionStepFailed\"")), true);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps local customer flower art deduction when post-finish lazySync returns stale bag", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-customer-finish-stale-sync-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    CUSTOMER_ORDER_GEN_BEFORE_ACTION: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?customer-finish-stale-sync-test=${Date.now()}`);
    const sync = {
      $usrTot: {
        data: {
          bag: {
            7: 99,
            300101: 3,
          },
        },
      },
      rchgTot: {
        cardMap: {},
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
            8: { artId: 300101, num: 3, cTime: "2026-06-16T01:50:00.000Z" },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {},
        },
      },
    };
    let lazySyncCount = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          lazySyncCount += 1;
          return lazySyncCount === 1
            ? raw({})
            : raw({
              $usrTot: {
                data: {
                  bag: {
                    300101: 3,
                  },
                },
              },
            });
        }
        if (iface === "gs.orderCustomer.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.orderCustomer.finishOrder"), true);
    assert.equal(result.$usrTot.data.bag[300101], 0);
    assert.equal(result.orderCustomerTot.orderCustomer.orderMap[8], undefined);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.flowerArtInventory.rows.some((row) => row.artId === 300101), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits decorate order even when satin order submission fails", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-orders-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?special-cycle-test=${Date.now()}`);
    const requestLog = [];
    const orderSync = {
      ...makeSync({}, 99),
      $usrTot: {
        ...makeSync({}, 99).$usrTot,
        cntMap: {},
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 5]],
            finishCnt: 63,
            isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z",
            cdTime: "2026-06-16T00:00:00.000Z",
          },
          orderDecorate: {
            flowers: [[23001, 5]],
            finishCnt: 60,
            isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z",
            cdTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(orderSync);
        if (iface === "gs.orderFlower.enter") return raw(orderSync);
        if (iface === "gs.orderFlower.finishSatinOrder") return { m: "satin order stuck" };
        if (iface === "gs.orderFlower.finishDecorateOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", orderSync, 1);

    assert.deepEqual(
      requestLog
        .map((item) => item.iface)
        .filter((iface) => iface.startsWith("gs.orderFlower.finish")),
      [
        "gs.orderFlower.finishSatinOrder",
        "gs.orderFlower.finishDecorateOrder",
      ],
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits a current satin task without enter and replans decorate from the satin response", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-order-cadence-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?special-order-cadence=${Date.now()}`);
    const base = makeSync({}, 2);
    const currentSync = {
      ...base,
      $usrTot: { ...base.$usrTot, cntMap: {} },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 1]], finishCnt: 8, isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z", cdTime: "2026-06-16T00:00:00.000Z",
          },
          orderDecorate: {
            flowers: [[23001, 1]], finishCnt: 7, isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z", cdTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const afterSatin = {
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            ...currentSync.orderFlowerTot.orderFlower.orderSatin,
            finishCnt: 9,
            cdTime: "2099-06-16T00:00:00.000Z",
          },
          orderDecorate: {
            ...currentSync.orderFlowerTot.orderFlower.orderDecorate,
            finishCnt: 8,
            cdTime: "2099-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderFlower.finishSatinOrder") return raw(afterSatin);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      currentSync,
      1,
    );

    assert.equal(requestLog.some(({ iface }) => iface === "gs.orderFlower.enter"), false);
    assert.equal(requestLog.filter(({ iface }) => iface === "gs.orderFlower.finishSatinOrder").length, 1);
    assert.equal(requestLog.some(({ iface }) => iface === "gs.orderFlower.finishDecorateOrder"), false);
    assert.equal(result.orderFlowerTot.orderFlower.orderDecorate.finishCnt, 8);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps a completed decorate response and does not revive the old task next cycle", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-order-no-revive-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?special-order-no-revive=${Date.now()}`);
    const base = makeSync({}, 1);
    let currentSync = {
      ...base,
      $usrTot: { ...base.$usrTot, cntMap: {} },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 1]], finishCnt: 9, isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z", cdTime: "2099-06-16T00:00:00.000Z",
          },
          orderDecorate: {
            flowers: [[23001, 1]], finishCnt: 4, isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z", cdTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const completedDecorate = {
      ...currentSync.orderFlowerTot.orderFlower.orderDecorate,
      finishCnt: 5,
      cdTime: "2099-06-16T00:00:00.000Z",
    };
    const oldEnterSnapshot = {
      orderFlowerTot: {
        orderFlower: {
          ...currentSync.orderFlowerTot.orderFlower,
          orderDecorate: {
            ...completedDecorate,
            finishCnt: 4,
            cdTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderFlower.enter") return raw(oldEnterSnapshot);
        if (iface === "gs.orderFlower.finishDecorateOrder") {
          currentSync = {
            ...currentSync,
            orderFlowerTot: {
              orderFlower: {
                ...currentSync.orderFlowerTot.orderFlower,
                orderDecorate: completedDecorate,
              },
            },
          };
          return raw({ orderFlowerTot: currentSync.orderFlowerTot });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    const specialOrderRefreshState = {};

    currentSync = await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      currentSync,
      1,
      { specialOrderRefreshState },
    );
    currentSync = await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      currentSync,
      2,
      { specialOrderRefreshState },
    );

    assert.equal(requestLog.some(({ iface }) => iface === "gs.orderFlower.enter"), false);
    assert.equal(requestLog.filter(({ iface }) => iface === "gs.orderFlower.finishDecorateOrder").length, 1);
    assert.equal(currentSync.orderFlowerTot.orderFlower.orderDecorate.finishCnt, 5);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle refreshes a missing special-order time once per Shanghai calendar day", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-order-daily-refresh-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  let nowMs = Date.parse("2026-09-01T23:50:00.000+08:00");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?special-order-daily-refresh=${Date.now()}`);
    const base = makeSync({}, 0);
    let currentSync = {
      ...base,
      $usrTot: { ...base.$usrTot, cntMap: {} },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 1]], finishCnt: 9, isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z", cdTime: "2099-06-16T00:00:00.000Z",
          },
          orderDecorate: {},
        },
      },
    };
    const refreshedOrderFlower = {
      orderSatin: currentSync.orderFlowerTot.orderFlower.orderSatin,
      orderDecorate: {
        flowers: [[23001, 1]], finishCnt: 5, isVideo: 0,
        cTime: "2026-09-01T15:50:00.000Z", cdTime: "2099-06-16T00:00:00.000Z",
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderFlower.enter") {
          currentSync = {
            ...currentSync,
            orderFlowerTot: { orderFlower: refreshedOrderFlower },
          };
          return raw({ orderFlowerTot: currentSync.orderFlowerTot });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };
    const specialOrderRefreshState = {};

    currentSync = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1, {
      specialOrderRefreshState,
    });
    currentSync = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 2, {
      specialOrderRefreshState,
    });
    assert.equal(requestLog.filter(({ iface }) => iface === "gs.orderFlower.enter").length, 1);
    nowMs = Date.parse("2026-09-02T00:10:00.000+08:00");
    currentSync = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 3, {
      specialOrderRefreshState,
    });
    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 4, {
      specialOrderRefreshState,
    });

    assert.equal(requestLog.filter(({ iface }) => iface === "gs.orderFlower.enter").length, 2);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle uses the explicit current satin task without enter", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-satin-state-regression-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logs = [];
  Date.now = () => Date.parse("2026-09-01T22:20:00.000+08:00");
  console.log = (line = "") => logs.push(String(line));
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?satin-state-regression=${Date.now()}`
    );
    const requestLog = [];
    const baseSync = makeSync({}, 0);
    const oldSatin = {
      flowers: [[23238, 6]],
      finishCnt: 52,
      isVideo: 0,
      cTime: "2026-09-01T14:10:00.000Z",
      cdTime: "2026-09-01T14:10:00.000Z",
    };
    const currentSatin = {
      flowers: [[23078, 1], [23095, 5]],
      finishCnt: 53,
      isVideo: 0,
      cTime: "2026-09-01T14:16:43.000Z",
      cdTime: "2026-09-01T14:16:43.000Z",
    };
    const staleSync = {
      ...baseSync,
      $usrTot: {
        ...baseSync.$usrTot,
        data: {
          ...baseSync.$usrTot.data,
          bag: {
            ...baseSync.$usrTot.data.bag,
            23238: 6,
            23078: 1,
            23095: 5,
          },
        },
        cntMap: {
          105: { type: 105, tdyCnt: 40, totCnt: 40, rTime: "2026-09-01T18:00:00.000+08:00" },
          109: { type: 109, tdyCnt: 1, totCnt: 11, rTime: "2026-09-01T18:00:00.000+08:00" },
          116: { type: 116, tdyCnt: 1, totCnt: 1, rTime: "2026-09-01T18:00:00.000+08:00" },
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: oldSatin,
          orderDecorate: {
            flowers: [[23001, 1]], finishCnt: 1, isVideo: 0,
            cTime: "2026-09-01T14:10:00.000Z", cdTime: "2099-09-01T14:10:00.000Z",
          },
        },
      },
    };
    const currentSync = {
      ...staleSync,
      orderFlowerTot: {
        orderFlower: {
          ...staleSync.orderFlowerTot.orderFlower,
          orderSatin: currentSatin,
        },
      },
    };
    let authoritativeExp = 1_000_000;
    const currentAuthoritySync = () => ({
      ...currentSync,
      $usrTot: {
        ...currentSync.$usrTot,
        data: {
          ...currentSync.$usrTot.data,
          lvl: 40,
          lvlExp: authoritativeExp,
          nextExp: 10_000_000,
        },
      },
    });
    const defaultExperienceConfig = loadExperienceSettlementConfig();
    const recordedExperienceConfig = {
      ...defaultExperienceConfig,
      flowers: new Map(defaultExperienceConfig.flowers),
    };
    // The captured current task settled for 520: 23078 x1 (300) and 23095 x5
    // (44 each). Keep this recorded task configuration local to this replay;
    // it exercises the state-authority path without changing production data.
    recordedExperienceConfig.flowers.set(23095, { id: 23095, experience: 44 });
    const estimatedOld = estimateExperienceAction({
      iface: "gs.orderFlower.finishSatinOrder",
      arg: {},
      syncValue: staleSync,
      config: recordedExperienceConfig,
      nowMs: Date.now(),
    });
    const estimatedCurrent = estimateExperienceAction({
      iface: "gs.orderFlower.finishSatinOrder",
      arg: {},
      syncValue: currentSync,
      config: recordedExperienceConfig,
      nowMs: Date.now(),
    });
    assert.equal(estimatedOld.maxExp, 360);
    assert.equal(estimatedCurrent.maxExp, 520);

    let orderEnterCount = 0;
    let landRefreshCount = 0;
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          landRefreshCount += 1;
          return raw(currentAuthoritySync());
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentAuthoritySync());
        if (iface === "gs.orderFlower.enter") {
          orderEnterCount += 1;
          return raw(currentAuthoritySync());
        }
        if (iface === "gs.orderFlower.finishSatinOrder") {
          authoritativeExp = 1_000_520;
          return raw({
            ...currentAuthoritySync(),
            orderFlowerTot: { orderFlower: { orderSatin: currentSatin } },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(ws, "test-token", currentSync, 1, {
      experienceConfig: recordedExperienceConfig,
    });

    assert.deepEqual(
      requestLog.filter((entry) => entry.iface === "gs.orderFlower.finishSatinOrder"),
      [{ iface: "gs.orderFlower.finishSatinOrder", args: {} }],
    );
    assert.equal(orderEnterCount, 0);
    assert.equal(result.orderFlowerTot.orderFlower.orderSatin.finishCnt, 53);
    assert.deepEqual(result.orderFlowerTot.orderFlower.orderSatin.flowers, [[23078, 1], [23095, 5]]);
    assert.equal(result.$usrTot.data.lvlExp, 1_000_520);
    const parsedLogs = logs.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    assert.equal(parsedLogs.some((entry) => (
      entry.step === "specialOrderSubmitted" && entry.kind === "satin"
    )), true);
    const satinAudit = parsedLogs.find((entry) => (
      entry.step === "experienceSettlementAudit"
      && entry.iface === "gs.orderFlower.finishSatinOrder"
    ));
    assert.equal(satinAudit?.predictedMaxExp, 520);
    assert.equal(satinAudit?.actualExpDelta, 520);
    assert.equal(parsedLogs.some((entry) => entry.step === "experienceGuardActionSkip"), false);
    assert.equal(parsedLogs.some((entry) => entry.step === "experienceUnexpectedSettlement"), false);
    assert.equal(parsedLogs.some((entry) => entry.step === "experienceSnapshotRegression"), false);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("central game sync replaces explicit order fields and preserves omitted fields", async () => {
  const { mergeGameSync } = await import("./garden-state.mjs");
  const oldSatin = { flowers: [[23238, 6]], finishCnt: 52, isVideo: 0, cTime: "old", cdTime: "old" };
  const oldDecorate = { flowers: [[23067, 5]], finishCnt: 51, isVideo: 0, cTime: "old", cdTime: "old" };
  const oldMap = { 8: { boxId: 8, flowers: [[23001, 1]], finishCnt: 7 } };
  const base = {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: oldSatin,
        orderDecorate: oldDecorate,
        orderMap: oldMap,
      },
    },
    taskTot: { main: { curTaskId: 1 } },
  };
  const authority = {
    orderFlowerTot: {
      orderFlower: {
        orderSatin: { flowers: [[23078, 1], [23095, 5]], finishCnt: 53, isVideo: 0, cTime: "new", cdTime: "new" },
        orderDecorate: { flowers: [[23067, 1]], finishCnt: 52, isVideo: 0, cTime: "new", cdTime: "new" },
        orderMap: { 9: { boxId: 9, flowers: [[23002, 1]], finishCnt: 8 } },
      },
    },
  };
  const merged = mergeGameSync(base, authority);
  assert.deepEqual(merged.orderFlowerTot.orderFlower, authority.orderFlowerTot.orderFlower);

  const partial = mergeGameSync(merged, { taskTot: { main: { curTaskId: 2 } } });
  assert.deepEqual(partial.orderFlowerTot.orderFlower, authority.orderFlowerTot.orderFlower);
  assert.equal(partial.taskTot.main.curTaskId, 2);
});

test("runGardenCycle refreshes a missing special-order time once and does not submit an incomplete result", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-incomplete-special-authority-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-09-01T22:20:00.000+08:00");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?incomplete-special-authority=${Date.now()}`
    );
    for (const [kind, finishIface] of [
      ["orderSatin", "gs.orderFlower.finishSatinOrder"],
      ["orderDecorate", "gs.orderFlower.finishDecorateOrder"],
    ]) {
      const incompleteTask = { flowers: [[23095, 5]], finishCnt: 54, isVideo: 0 };
      const base = makeSync({}, 0);
      const otherKind = kind === "orderSatin" ? "orderDecorate" : "orderSatin";
      const initialSync = {
        ...base,
        $usrTot: {
          ...base.$usrTot,
          cntMap: {},
          data: { ...base.$usrTot.data, bag: { ...base.$usrTot.data.bag, 23078: 1, 23095: 5 } },
        },
        orderFlowerTot: {
          orderFlower: {
            [kind]: incompleteTask,
            [otherKind]: {
              flowers: [[23001, 1]], finishCnt: 1, isVideo: 0,
              cTime: "2026-09-01T14:16:43.000Z", cdTime: "2099-09-01T14:16:43.000Z",
            },
          },
        },
      };
      const incompleteSync = { orderFlowerTot: { orderFlower: { [kind]: incompleteTask } } };
      const requests = [];
      let enterCount = 0;
      const ws = {
        async request(iface, args) {
          requests.push({ iface, args });
          if (iface === "gs.usrLand.refresh") return raw(initialSync);
          if (iface === "gs.usr.heartTick") return raw({});
          if (iface === "gs.orderFlower.enter") {
            enterCount += 1;
            return raw(incompleteSync);
          }
          throw new Error(`unexpected iface ${iface}`);
        },
      };

      const result = await runGardenCycle(ws, "test-token", initialSync, 1);
      assert.equal(enterCount, 1, `${kind} must refresh its missing time only once per cycle`);
      assert.equal(requests.some(({ iface }) => iface === finishIface), false, `${kind} must not submit an incomplete refresh result`);
      assert.deepEqual(result.orderFlowerTot.orderFlower[kind], incompleteTask);
    }
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle refreshes after special order 301 and does not retry stale ready stock next cycle", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-order-stock-rejection-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => logs.push(String(line));
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?special-order-stock-rejection=${Date.now()}`
    );
    const requestLog = [];
    const staleSync = {
      ...makeSync({}, 80),
      $usrTot: {
        ...makeSync({}, 80).$usrTot,
        cntMap: {},
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 1]],
            finishCnt: 63,
            isVideo: 0,
            cdTime: "2026-06-16T00:00:00.000Z",
            cTime: "2026-06-16T00:00:00.000Z",
          },
          orderDecorate: {},
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(staleSync);
        if (iface === "gs.orderFlower.enter") return raw(staleSync);
        if (iface === "gs.orderFlower.finishSatinOrder") {
          return { m: { code: 301, param: { iid: 23001 } } };
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    let result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", staleSync, 1);
    result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", result, 2);

    assert.equal(
      requestLog.filter((entry) => entry.iface === "gs.orderFlower.finishSatinOrder").length,
      1,
    );
    assert.equal(
      requestLog.filter((entry) => entry.iface === "gs.orderFlower.enter").length >= 3,
      true,
    );
    assert.equal(result.$specialOrderStockRejections.satin.itemId, 23001);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.specialOrders.satin.status, "server-confirmed-out-of-stock");
    assert.equal(statusJson.specialOrders.satin.canFinish, false);
    assert.equal(statusJson.specialOrders.satin.stockRejection.itemId, 23001);
    assert.equal(statusJson.specialOrders.satin.stockRejection.exactHaveKnown, false);

    const parsedLogs = logs.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    assert.equal(parsedLogs.some((entry) => (
      entry.step === "specialOrderStockLazySyncAfterRejected"
      && entry.iface === "gs.usr.lazySync"
    )), true);
    assert.equal(parsedLogs.some((entry) => (
      entry.step === "specialOrderStockRejected"
      && entry.kind === "satin"
      && entry.itemId === 23001
      && entry.code === 301
    )), true);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle tries decorate at trigger-adjacent total when satin fails", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-orders-trigger-adjacent-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?special-trigger-adjacent-cycle-test=${Date.now()}`);
    const requestLog = [];
    const orderSync = {
      ...makeSync({}, 99),
      $usrTot: {
        ...makeSync({}, 99).$usrTot,
        cntMap: {
          105: { type: 105, tdyCnt: 41, totCnt: 300 },
          109: { type: 109, tdyCnt: 4, totCnt: 120 },
          116: { type: 116, tdyCnt: 5, totCnt: 80 },
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 5]],
            finishCnt: 63,
            isVideo: 0,
            cdTime: "2026-06-16T00:00:00.000Z",
          },
          orderDecorate: {
            flowers: [[23001, 5]],
            finishCnt: 60,
            isVideo: 0,
            cdTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(orderSync);
        if (iface === "gs.orderFlower.enter") return raw(orderSync);
        if (iface === "gs.orderFlower.finishSatinOrder") return { m: "satin order stuck" };
        if (iface === "gs.orderFlower.finishDecorateOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", orderSync, 1);

    assert.deepEqual(
      requestLog
        .map((item) => item.iface)
        .filter((iface) => iface.startsWith("gs.orderFlower.finish")),
      [
        "gs.orderFlower.finishSatinOrder",
        "gs.orderFlower.finishDecorateOrder",
      ],
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle rechecks a newly enabled 49/99 protection switch before an unsent resident action", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-protection-preflight-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?team-protection-preflight=${Date.now()}`
    );
    const requestLog = [];
    const orderSync = {
      ...makeSync({}, 99),
      videoDouble: {
        videoCnt: 1,
        eTime: "2099-01-01T00:00:00.000Z",
      },
      $usrTot: {
        ...makeSync({}, 99).$usrTot,
        cntMap: {
          105: { type: 105, tdyCnt: 42, totCnt: 300 },
          109: { type: 109, tdyCnt: 4, totCnt: 120 },
          116: { type: 116, tdyCnt: 5, totCnt: 80 },
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 5]],
            finishCnt: 63,
            isVideo: 0,
            cdTime: "2026-06-16T00:00:00.000Z",
          },
          orderDecorate: {},
        },
      },
    };
    let capabilityCalls = 0;
    const cancelledReservations = [];
    const teamOrderRuntime = {
      signal: null,
      config: null,
      bind() {},
      capability() {
        capabilityCalls += 1;
        return {
          ready: true,
          enabled: true,
          realValidated: false,
          teamOrderTriggerProtectionEnabled: capabilityCalls !== 2,
        };
      },
      async handle(syncValue) {
        return {
          syncValue,
          handled: false,
          finalReason: "idle",
        };
      },
      takeFatalError() {
        return null;
      },
      cancelTriggerReservation(action, reason) {
        cancelledReservations.push({ action, reason });
        return null;
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(orderSync);
        if (iface === "gs.orderFlower.enter") return raw(orderSync);
        if (iface === "gs.orderFlower.finishSatinOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      orderSync,
      1,
      { teamOrderRuntime },
    );

    assert.ok(capabilityCalls >= 3);
    assert.equal(
      requestLog.some((entry) => entry.iface === "gs.orderFlower.finishSatinOrder"),
      false,
    );
    assert.equal(cancelledReservations.length, 1);
    assert.equal(cancelledReservations[0].reason, "preflight-plan-changed");
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle releases the exact trigger reservation when the resident request fails", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-trigger-failed-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?team-trigger-request-failed=${Date.now()}`
    );
    const baseSync = makeSync({}, 99);
    const orderSync = {
      ...baseSync,
      videoDouble: {
        videoCnt: 1,
        eTime: "2099-01-01T00:00:00.000Z",
      },
      $usrTot: {
        ...baseSync.$usrTot,
        cntMap: {
          105: { type: 105, tdyCnt: 42, totCnt: 300 },
          109: { type: 109, tdyCnt: 4, totCnt: 120 },
          116: { type: 116, tdyCnt: 5, totCnt: 80 },
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 5]],
            finishCnt: 63,
            isVideo: 0,
            cdTime: "2026-06-16T00:00:00.000Z",
          },
          orderDecorate: {},
        },
      },
    };
    const cancelledReservations = [];
    const teamOrderRuntime = {
      signal: null,
      config: null,
      bind() {},
      capability() {
        return {
          ready: true,
          enabled: true,
          realValidated: false,
          teamOrderTriggerProtectionEnabled: false,
          requiresExperienceTriggerDecision: true,
          evaluateTrigger() {
            return {
              blocked: false,
              coldStartBypass: false,
              reason: "historical-experience-space-available",
              teamOrderReservationId: "team-exp-request-failed",
            };
          },
        };
      },
      async handle(syncValue) {
        return {
          syncValue,
          handled: false,
          finalReason: "idle",
        };
      },
      takeFatalError() {
        return null;
      },
      cancelTriggerReservation(action, reason) {
        cancelledReservations.push({ action, reason });
        return {
          teamOrderReservationId:
            action.teamTriggerDecision?.teamOrderReservationId ?? null,
          reason,
        };
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(orderSync);
        if (iface === "gs.orderFlower.enter") return raw(orderSync);
        if (iface === "gs.orderFlower.finishSatinOrder") {
          return { m: "satin order rejected" };
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      orderSync,
      1,
      { teamOrderRuntime },
    );

    assert.equal(
      requestLog.some((entry) => entry.iface === "gs.orderFlower.finishSatinOrder"),
      true,
    );
    assert.equal(cancelledReservations.length, 1);
    assert.equal(
      cancelledReservations[0].action.teamTriggerDecision.teamOrderReservationId,
      "team-exp-request-failed",
    );
    assert.equal(
      cancelledReservations[0].reason,
      "resident-order-request-failed",
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps online heartTick on client cadence and merges returned resources", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-hearttick-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?hearttick-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = makeSync({}, 0);
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  7: 123,
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const first = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);
    const second = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", first, 2);

    assert.equal(requestLog.filter((item) => item.iface === "gs.usr.heartTick").length, 1);
    assert.equal(first.$usrTot.data.bag[7], 123);
    assert.ok(second);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle ignores incomplete cyclic story state without type, phase, or batchId", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-no-cyclic-story-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "1",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?no-cyclic-story-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = {
      ...makeSync({}, 0),
      actTot: {
        map: {
          90001: {
            actId: 4003,
            ext: {
              cyclicStory: {
                orderInfo: {
                  0: { flowerId: 23001, orderId: 1, num: 1, validTime: "2026-06-16T00:00:00.000Z" },
                },
              },
            },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        assert.ok(!iface.startsWith("gs.actCyclicStory."), `unexpected cyclic story request ${iface}`);
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
    );

    const statusHtml = fs.readFileSync(path.join(outDir, "garden-status.html"), "utf8");
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));

    assert.doesNotMatch(statusHtml, /莳花纪闻/);
    assert.equal(statusJson.cyclicStory.exists, false);
    assert.equal(statusJson.cyclicStory.active, false);
    assert.equal(
      statusJson.automationQueue.rows.some((row) => row.area === "莳花纪闻"),
      false,
    );
    assert.equal(requestLog.some((item) => item.iface.startsWith("gs.actCyclicStory.")), false);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle resumes an active team order before normal order work", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-active-team-order-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?active-team-order-cycle-test=${Date.now()}`);
    const requestLog = [];
    const startTime = Date.now();
    const baseSync = {
      ...makeSync({}, 20),
      orderTeamTot: {
        orderTeam: {
          status: 2,
          startTime,
          orderNum: 1,
          flowerId: 23001,
          remainingNum: 1,
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderTeam.submitOrder" || iface === "gs.orderTeam.recvRwd") {
          return raw({
            orderTeamTot: {
              orderTeam: {
                ...baseSync.orderTeamTot.orderTeam,
                status: 3,
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);

    assert.equal(requestLog[0].iface, "gs.usrLand.refresh");
    assert.equal(requestLog[1].iface, "gs.usr.heartTick");
    assert.ok(requestLog.some((item) => item.iface === "gs.orderTeam.submitOrder"));
    assert.equal(requestLog.some((item) => item.args?.isCost === true), false);
    assert.equal(result.orderTeamTot.orderTeam.status, 3);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team checkpoint forwards a missing order object so pending settlement can close", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-missing-terminal-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?missing-team-order-terminal-test=${Date.now()}`
    );
    const baseSync = makeSync({}, 0);
    const checkpointTriggers = [];
    const teamOrderRuntime = {
      bind() {},
      capability() {
        return { ready: true, enabled: true };
      },
      config: {},
      runner: {
        async handle(syncValue, context) {
          checkpointTriggers.push(context.trigger);
          return {
            syncValue,
            handled: true,
            finalReason: "server-ended",
          };
        },
      },
      takeFatalError() {
        return null;
      },
    };
    const ws = {
      async request(iface) {
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      { teamOrderRuntime },
    );

    assert.deepEqual(checkpointTriggers, ["startup"]);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle immediately rolls over a paid renewal and polls pending settlement before continuing", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-settlement-poll-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?pending-team-settlement-poll=${Date.now()}`
    );
    const baseSync = makeSync({}, 0);
    const timeline = [];
    let handleCount = 0;
    let nowMs = 0;
    const teamOrderRuntime = {
      signal: null,
      bind() {},
      capability() {
        return { ready: true, enabled: true };
      },
      config: {},
      async handle(syncValue) {
        handleCount += 1;
        timeline.push(`team:${handleCount}`);
        return {
          syncValue,
          handled: true,
          finalReason:
            handleCount === 1
              ? "paid-renew-continued"
              : handleCount < 4
              ? "settlement-pending"
              : "server-ended",
        };
      },
      takeFatalError() {
        return null;
      },
    };
    const ws = {
      async request(iface) {
        timeline.push(iface);
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      baseSync,
      1,
      {
        teamOrderRuntime,
        teamOrderSettlementPollMs: 25,
        delayNowFn: () => nowMs,
        waitFn: async (milliseconds) => {
          timeline.push(`wait:${milliseconds}`);
          nowMs += milliseconds;
        },
      },
    );

    assert.equal(handleCount, 4);
    assert.deepEqual(timeline.slice(0, 8), [
      "gs.usrLand.refresh",
      "gs.usr.heartTick",
      "team:1",
      "team:2",
      "wait:25",
      "team:3",
      "wait:25",
      "team:4",
    ]);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle checkpoints after each satin and decorate response with the latest sync", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-special-team-checkpoints-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-24T02:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?special-team-checkpoints=${Date.now()}`
    );
    let checkpointCount = 0;
    let currentSync = {
      ...makeSync({}, 99),
      $usrTot: {
        ...makeSync({}, 99).$usrTot,
        cntMap: {},
      },
      orderTeamTot: { orderTeam: { status: 0 } },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 1]], finishCnt: 9, isVideo: 0,
            cTime: "2026-07-24T01:00:00.000Z", cdTime: "2026-07-24T01:00:00.000Z",
          },
          orderDecorate: {
            flowers: [[23001, 1]], finishCnt: 7, isVideo: 0,
            cTime: "2026-07-24T01:00:00.000Z", cdTime: "2026-07-24T01:00:00.000Z",
          },
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderFlower.enter") return raw(currentSync);
        if (
          iface === "gs.orderFlower.finishSatinOrder"
          || iface === "gs.orderFlower.finishDecorateOrder"
        ) {
          currentSync = {
            ...currentSync,
            orderTeamTot: {
              orderTeam: {
                status: 2,
                startTime: nowMs,
                orderNum: 1,
                flowerId: 23001,
              },
            },
          };
          return raw({ orderTeamTot: currentSync.orderTeamTot });
        }
        if (iface === "gs.orderTeam.submitOrder") {
          checkpointCount += 1;
          currentSync = {
            ...currentSync,
            checkpointMarker: checkpointCount,
            orderTeamTot: { orderTeam: { status: 0 } },
          };
          return raw({
            checkpointMarker: checkpointCount,
            orderTeamTot: currentSync.orderTeamTot,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      currentSync,
      1,
    );
    const relevantIfaces = requestLog
      .map((entry) => entry.iface)
      .filter((iface) => [
        "gs.orderFlower.finishSatinOrder",
        "gs.orderFlower.finishDecorateOrder",
        "gs.orderTeam.submitOrder",
      ].includes(iface));

    assert.deepEqual(relevantIfaces, [
      "gs.orderFlower.finishSatinOrder",
      "gs.orderTeam.submitOrder",
      "gs.orderFlower.finishDecorateOrder",
      "gs.orderTeam.submitOrder",
    ]);
    assert.equal(checkpointCount, 2);
    assert.equal(result.checkpointMarker, 2);
    assert.equal(requestLog.some((entry) => entry.args?.isCost === true), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle refreshes truth after a team business rejection and continues without an old runner lock", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-error-isolation-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-24T02:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?team-error-isolation=${Date.now()}`
    );
    let currentSync = {
      ...makeSync({}, 99),
      orderTeamTot: {
        orderTeam: {
          status: 2,
          startTime: nowMs,
          orderNum: 1,
          flowerId: 23001,
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {},
          orderDecorate: {},
        },
      },
    };
    let teamRequestCount = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.orderFlower.enter") return raw(currentSync);
        if (iface === "gs.orderTeam.submitOrder") {
          teamRequestCount += 1;
          if (teamRequestCount === 1) return { m: "team business rejected" };
          currentSync = {
            ...currentSync,
            orderTeamTot: { orderTeam: { status: 0 } },
          };
          return raw({ orderTeamTot: currentSync.orderTeamTot });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const first = await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      currentSync,
      1,
    );
    const firstTeamIndex = requestLog.findIndex((entry) => entry.iface === "gs.orderTeam.submitOrder");
    const laterGardenIndex = requestLog.findIndex((entry) => entry.iface === "gs.orderFlower.enter");
    assert.equal(teamRequestCount, 2);
    assert.ok(laterGardenIndex > firstTeamIndex);
    assert.equal(first.orderTeamTot.orderTeam.status, 0);
    const firstStatus = JSON.parse(
      fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"),
    );
    assert.equal(
      firstStatus.summary.cycleErrors.some((entry) => entry.step === "teamOrderCheckpointError"),
      false,
    );

    const second = await runGardenCycle(
      withDefaultExperienceLazySync(ws),
      "test-token",
      first,
      2,
    );
    assert.equal(teamRequestCount, 2);
    assert.equal(second.orderTeamTot.orderTeam.status, 0);
    assert.equal(requestLog.some((entry) => entry.args?.isCost === true), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("team checkpoints preserve session-expired and websocket-timeout global semantics", async () => {
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-24T02:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?team-fatal-semantics=${Date.now()}`
    );
    const activeSync = {
      ...makeSync({}, 99),
      orderTeamTot: {
        orderTeam: {
          status: 2,
          startTime: nowMs,
          orderNum: 1,
          flowerId: 23001,
        },
      },
    };

    for (const message of [
      "账号已在其他设备登录",
      "WS request timeout gs.orderTeam.submitOrder",
    ]) {
      const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-fatal-"));
      process.env.STATUS_DOC_DIR = outDir;
      const ws = {
        async request(iface) {
          if (iface === "gs.usrLand.refresh") return raw(activeSync);
          if (iface === "gs.usr.heartTick") return raw({});
          if (iface === "gs.usr.lazySync") return raw({});
          if (iface === "gs.orderTeam.submitOrder") throw new Error(message);
          throw new Error(`unexpected iface ${iface}`);
        },
      };
      await assert.rejects(
        () => runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", activeSync, 1),
        new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
  }
});

test("per-order team checkpoints rethrow fatal errors before later resident-order actions", async () => {
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-24T02:00:00.000Z");
  Date.now = () => nowMs;

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?per-order-team-fatal-semantics=${Date.now()}`
    );
    const fatalCases = [
      {
        name: "session-expired",
        createError() {
          return new Error("账号已在其他设备登录");
        },
      },
      {
        name: "ws-request-timeout",
        createError() {
          return new Error("WS request timeout gs.orderTeam.submitOrder");
        },
      },
      {
        name: "experience-guard",
        createError() {
          const error = new Error("经验保护已停止收益类自动任务");
          error.reason = "experience-guard";
          error.category = "experience-guard";
          return error;
        },
      },
    ];

    for (const orderKind of ["special", "ordinary"]) {
      for (const fatalCase of fatalCases) {
        const outDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `garden-cycle-${orderKind}-${fatalCase.name}-`),
        );
        const settingsPath = path.join(outDir, "profile-settings.json");
        fs.writeFileSync(
          settingsPath,
          `${JSON.stringify({ autoSubmitOrdinaryResidentOrdersForLevelUp: true })}\n`,
          "utf8",
        );
        assignCycleEnv({
          STATUS_DOC_DIR: outDir,
          PROFILE_SETTINGS_PATH: settingsPath,
          AUTO_HANDLE_TEAM_ORDERS: "1",
          AUTO_SUBMIT_SPECIAL_ORDERS: "1",
          AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: orderKind === "ordinary" ? "1" : "0",
          AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
          AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
          AUTO_HANDLE_FLOWER_RACK: "0",
          AUTO_HANDLE_PEARL: "0",
          AUTO_SUBMIT_MAIN_TASKS: "0",
        });

        const task = getResidentOrderMainTaskForTest();
        const taskId = Number(task.id);
        const targetValue = Number(task.value);
        let currentSync = {
          ...makeSync({}, orderKind === "special" ? 99 : 0),
          $usrTot: {
            data: {
              bag: {
                7: 99,
                23001: 99,
              },
            },
            cntMap: {
              105: {
                type: 105,
                tdyCnt: orderKind === "special" ? 98 : 0,
                rTime: "2026-07-24T01:00:00.000Z",
              },
              109: {
                type: 109,
                tdyCnt: orderKind === "special" ? 1 : 121,
                rTime: "2026-07-24T01:00:00.000Z",
              },
              116: {
                type: 116,
                tdyCnt: orderKind === "special" ? 1 : 121,
                rTime: "2026-07-24T01:00:00.000Z",
              },
            },
          },
          taskTot: {
            main: {
              curTaskId: taskId,
              curValue: targetValue - 2,
              recvMap: {},
            },
          },
          orderTeamTot: {
            orderTeam: { status: 0 },
          },
          orderFlowerTot: {
            orderFlower: {
              orderMap: {
                301: {
                  boxId: 301,
                  flowers: [[23001, 1]],
                  isVideo: 0,
                  cdTime: "2026-07-24T01:00:00.000Z",
                },
                302: {
                  boxId: 302,
                  flowers: [[23001, 1]],
                  isVideo: 0,
                  cdTime: "2026-07-24T01:00:00.000Z",
                },
              },
              orderSatin: { flowers: [[23001, 1]], finishCnt: 9, isVideo: 0 },
              orderDecorate: { flowers: [[23001, 1]], finishCnt: 7, isVideo: 0 },
            },
          },
        };
        const requestLog = [];
        const checkpointTriggers = [];
        const fatalError = fatalCase.createError();
        const teamOrderRuntime = {
          bind() {},
          capability() {
            return { ready: true, enabled: true };
          },
          config: {},
          runner: {
            async handle(syncValue, context) {
              checkpointTriggers.push(context.trigger);
              if (context.trigger === "startup") {
                return { syncValue, handled: false, finalReason: "idle" };
              }
              throw fatalError;
            },
          },
          takeFatalError() {
            return null;
          },
        };
        const ws = {
          async request(iface, args) {
            requestLog.push({ iface, args });
            if (iface === "gs.usrLand.refresh") return raw(currentSync);
            if (iface === "gs.usr.heartTick") return raw({});
            if (iface === "gs.usr.lazySync") return raw({ taskTot: currentSync.taskTot });
            if (iface === "gs.orderFlower.enter") return raw(currentSync);
            if (
              iface === "gs.orderFlower.finishSatinOrder"
              || iface === "gs.orderFlower.finishDecorateOrder"
            ) {
              return raw({});
            }
            if (iface === "gs.orderFlower.finishOrder") {
              delete currentSync.orderFlowerTot.orderFlower.orderMap[args.boxId];
              currentSync.taskTot.main.curValue += 1;
              return raw({
                taskTot: currentSync.taskTot,
                orderFlowerTot: currentSync.orderFlowerTot,
              });
            }
            throw new Error(`unexpected iface ${iface}`);
          },
        };

        await assert.rejects(
          () => runGardenCycle(
            withDefaultExperienceLazySync(ws),
            "test-token",
            currentSync,
            1,
            { teamOrderRuntime },
          ),
          (error) => error === fatalError,
          `${orderKind} ${fatalCase.name}`,
        );
        assert.deepEqual(
          checkpointTriggers,
          [
            "startup",
            orderKind === "special"
              ? "special-order-submitted"
              : "ordinary-resident-order-submitted",
          ],
          `${orderKind} ${fatalCase.name} must not retry the team checkpoint`,
        );
        const residentSubmitIfaces = requestLog
          .map(({ iface }) => iface)
          .filter((iface) => [
            "gs.orderFlower.finishSatinOrder",
            "gs.orderFlower.finishDecorateOrder",
            "gs.orderFlower.finishOrder",
          ].includes(iface));
        assert.equal(
          residentSubmitIfaces.length,
          1,
          `${orderKind} ${fatalCase.name} must stop before the next resident order`,
        );
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
  }
});

test("real team runtime stops per-order fatal checkpoints before resync or later actions", async () => {
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-24T02:00:00.000Z");
  Date.now = () => nowMs;

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?real-per-order-team-fatal-semantics=${Date.now()}`
    );
    const fatalCases = [
      {
        name: "session-expired",
        createError() {
          return new Error("账号已在其他设备登录");
        },
      },
      {
        name: "ws-request-timeout",
        createError() {
          return new Error("WS request timeout gs.orderTeam.submitOrder");
        },
      },
      {
        name: "experience-guard",
        createError() {
          const error = new Error("经验保护已停止收益类自动任务");
          error.reason = "experience-guard";
          error.category = "experience-guard";
          return error;
        },
      },
    ];

    for (const orderKind of ["special", "ordinary"]) {
      for (const fatalCase of fatalCases) {
        const outDir = fs.mkdtempSync(
          path.join(os.tmpdir(), `garden-cycle-real-${orderKind}-${fatalCase.name}-`),
        );
        const settingsPath = path.join(outDir, "profile-settings.json");
        fs.writeFileSync(
          settingsPath,
          `${JSON.stringify({ autoSubmitOrdinaryResidentOrdersForLevelUp: true })}\n`,
          "utf8",
        );
        assignCycleEnv({
          STATUS_DOC_DIR: outDir,
          PROFILE_SETTINGS_PATH: settingsPath,
          AUTO_HANDLE_TEAM_ORDERS: "1",
          AUTO_SUBMIT_SPECIAL_ORDERS: "1",
          AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: orderKind === "ordinary" ? "1" : "0",
          AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
          AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
          AUTO_HANDLE_FLOWER_RACK: "0",
          AUTO_HANDLE_PEARL: "0",
          AUTO_SUBMIT_MAIN_TASKS: "0",
        });

        const task = getResidentOrderMainTaskForTest();
        const taskId = Number(task.id);
        const targetValue = Number(task.value);
        let currentSync = {
          ...makeSync({}, 99),
          $usrTot: {
            data: {
              lvl: 40,
              lvlExp: 1000000,
              nextExp: 10000000,
              bag: {
                7: 99,
                23001: 99,
              },
            },
            cntMap: {
              105: {
                type: 105,
                tdyCnt: orderKind === "special" ? 98 : 0,
                rTime: "2026-07-24T01:00:00.000Z",
              },
              109: {
                type: 109,
                tdyCnt: orderKind === "special" ? 1 : 121,
                rTime: "2026-07-24T01:00:00.000Z",
              },
              116: {
                type: 116,
                tdyCnt: orderKind === "special" ? 1 : 121,
                rTime: "2026-07-24T01:00:00.000Z",
              },
            },
          },
          taskTot: {
            main: {
              curTaskId: taskId,
              curValue: targetValue - 2,
              recvMap: {},
            },
          },
          orderTeamTot: {
            orderTeam: { status: 0 },
          },
          orderFlowerTot: {
            orderFlower: {
              orderMap: {
                301: {
                  boxId: 301,
                  flowers: [[23001, 1]],
                  isVideo: 0,
                  cdTime: "2026-07-24T01:00:00.000Z",
                },
                302: {
                  boxId: 302,
                  flowers: [[23001, 1]],
                  isVideo: 0,
                  cdTime: "2026-07-24T01:00:00.000Z",
                },
              },
              orderSatin: { flowers: [[23001, 1]], finishCnt: 9, isVideo: 0 },
              orderDecorate: { flowers: [[23001, 1]], finishCnt: 7, isVideo: 0 },
            },
          },
        };
        const requestLog = [];
        const afterFatalRequests = [];
        const fatalError = fatalCase.createError();
        let fatalObserved = false;
        const ws = {
          async request(iface, args) {
            requestLog.push({ iface, args });
            if (fatalObserved) afterFatalRequests.push(iface);
            if (iface === "gs.usrLand.refresh") return raw(currentSync);
            if (iface === "gs.usr.heartTick") return raw({});
            if (iface === "gs.usr.lazySync") return raw({ taskTot: currentSync.taskTot });
            if (iface === "gs.orderFlower.enter") return raw(currentSync);
            if (
              iface === "gs.orderFlower.finishSatinOrder"
              || iface === "gs.orderFlower.finishDecorateOrder"
            ) {
              currentSync = {
                ...currentSync,
                orderTeamTot: {
                  orderTeam: {
                    status: 2,
                    startTime: nowMs,
                    orderNum: 1,
                    flowerId: 23001,
                  },
                },
              };
              return raw({ orderTeamTot: currentSync.orderTeamTot });
            }
            if (iface === "gs.orderFlower.finishOrder") {
              const orderMap = { ...currentSync.orderFlowerTot.orderFlower.orderMap };
              delete orderMap[args.boxId];
              currentSync = {
                ...currentSync,
                taskTot: {
                  main: {
                    ...currentSync.taskTot.main,
                    curValue: currentSync.taskTot.main.curValue + 1,
                  },
                },
                orderTeamTot: {
                  orderTeam: {
                    status: 2,
                    startTime: nowMs,
                    orderNum: 1,
                    flowerId: 23001,
                  },
                },
                orderFlowerTot: {
                  orderFlower: {
                    ...currentSync.orderFlowerTot.orderFlower,
                    orderMap,
                  },
                },
              };
              return raw({
                taskTot: currentSync.taskTot,
                orderTeamTot: currentSync.orderTeamTot,
                orderFlowerTot: currentSync.orderFlowerTot,
              });
            }
            if (iface === "gs.orderTeam.submitOrder") {
              fatalObserved = true;
              throw fatalError;
            }
            throw new Error(`unexpected iface ${iface}`);
          },
        };

        await assert.rejects(
          () => runGardenCycle(
            withDefaultExperienceLazySync(ws),
            "test-token",
            currentSync,
            1,
          ),
          (error) => error === fatalError,
          `${orderKind} ${fatalCase.name} must reject with the original Error object`,
        );
        assert.equal(
          requestLog.filter(({ iface }) => iface === "gs.orderTeam.submitOrder").length,
          1,
          `${orderKind} ${fatalCase.name} must not retry the team submit`,
        );
        assert.equal(
          requestLog.filter(({ iface }) => [
            "gs.orderFlower.finishSatinOrder",
            "gs.orderFlower.finishDecorateOrder",
            "gs.orderFlower.finishOrder",
          ].includes(iface)).length,
          1,
          `${orderKind} ${fatalCase.name} must stop before a later resident action`,
        );
        assert.deepEqual(
          afterFatalRequests,
          [],
          `${orderKind} ${fatalCase.name} must not issue refreshTruth lazySync or any later request`,
        );
        fs.rmSync(outDir, { recursive: true, force: true });
      }
    }
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
  }
});

test("team checkpoint archives use outputs by default and preserve an explicit account status directory", async () => {
  const oldEnv = { ...process.env };
  const oldCwd = process.cwd();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-team-archive-root-"));
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-07-24T02:00:00.000Z");
  Date.now = () => nowMs;

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?team-archive-default-dir=${Date.now()}`
    );
    fs.mkdirSync(path.join(rootDir, "work"), { recursive: true });
    fs.copyFileSync(
      path.join(oldCwd, "work", "g-data.69b61.text"),
      path.join(rootDir, "work", "g-data.69b61.text"),
    );
    process.chdir(rootDir);
    assignCycleEnv({
      AUTO_HANDLE_TEAM_ORDERS: "1",
      AUTO_SUBMIT_SPECIAL_ORDERS: "0",
      AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
      AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
      AUTO_HANDLE_FLOWER_RACK: "0",
      AUTO_HANDLE_PEARL: "0",
      AUTO_SUBMIT_MAIN_TASKS: "0",
    });

    for (const statusDir of [null, path.join(rootDir, "account-status")]) {
      if (statusDir == null) delete process.env.STATUS_DOC_DIR;
      else process.env.STATUS_DOC_DIR = statusDir;
      const expectedStatusDir = statusDir || path.join(rootDir, "outputs");
      let currentSync = {
        ...makeSync({}, 99),
        $usrTot: {
          ...makeSync({}, 99).$usrTot,
          data: {
            ...makeSync({}, 99).$usrTot.data,
            id: statusDir == null ? "default-output-user" : "account-output-user",
          },
        },
        orderTeamTot: {
          orderTeam: {
            status: statusDir == null ? 2 : 1,
            ...(statusDir == null
              ? { startTime: nowMs }
              : { startTime: null }),
            orderNum: 1,
            flowerId: 23001,
          },
        },
      };
      const ws = {
        async request(iface) {
          if (iface === "gs.usrLand.refresh") return raw(currentSync);
          if (iface === "gs.usr.heartTick") return raw({});
          if (iface === "gs.usr.lazySync") return raw({});
          if (iface === "gs.orderFlower.enter") return raw(currentSync);
          if (iface === "gs.orderTeam.takeOrder") {
            currentSync = {
              ...currentSync,
              orderTeamTot: {
                orderTeam: {
                  ...currentSync.orderTeamTot.orderTeam,
                  status: 2,
                  activeTime: nowMs - 999,
                  cTime: nowMs - 1_000,
                },
              },
            };
            return raw({ orderTeamTot: currentSync.orderTeamTot });
          }
          if (iface === "gs.orderTeam.submitOrder" || iface === "gs.orderTeam.recvRwd") {
            currentSync = {
              ...currentSync,
              orderTeamTot: {
                orderTeam: {
                  ...currentSync.orderTeamTot.orderTeam,
                  status: iface === "gs.orderTeam.submitOrder" ? 3 : 0,
                },
              },
            };
            return raw({ orderTeamTot: currentSync.orderTeamTot });
          }
          throw new Error(`unexpected iface ${iface}`);
        },
      };

      await runGardenCycle(
        withDefaultExperienceLazySync(ws),
        "test-token",
        currentSync,
        1,
      );

      const archiveDir = path.join(expectedStatusDir, "team-orders");
      const archiveFiles = fs.readdirSync(archiveDir);
      assert.equal(archiveFiles.filter((name) => name.endsWith(".json")).length, 1);
      assert.equal(archiveFiles.filter((name) => name.endsWith(".html")).length, 1);
    }
  } finally {
    Date.now = oldNow;
    process.chdir(oldCwd);
    process.env = oldEnv;
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runAutomationSession creates one team runtime and reuses it across cycle calls", () => {
  const source = fs.readFileSync(
    path.join("work", "inspect-garden-dryrun.mjs"),
    "utf8",
  );
  assert.match(
    source,
    /const teamOrderRuntime = createTeamOrderSessionRuntime\(syncValue/,
  );
  assert.match(
    source,
    /runGardenCycle\(ws,\s*gsToken,\s*syncValue,\s*cycle,\s*\{\s*teamOrderRuntime,\s*accountScheduler\s*\}\)/,
  );
});

test("runAutomationSession always closes the active websocket when the loop exits", () => {
  const source = fs.readFileSync(
    path.join("work", "inspect-garden-dryrun.mjs"),
    "utf8",
  );
  const loopBranch = source.match(
    /if \(\["auto-loop", "loop", "watch"\]\.includes\(process\.env\.ACTION\)\) \{([\s\S]*?)\n  let land =/,
  )?.[1] || "";

  assert.match(loopBranch, /finally \{\s*ws\.close\(\);\s*\}/);
  assert.equal(loopBranch.match(/ws\.close\(\)/g)?.length, 1);
});

test("runGardenCycle scans guild land every 15 minutes and harvests mature guild flowers", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-fml-land-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logs = [];
  let nowMs = Date.parse("2026-06-17T12:00:00.000Z");
  Date.now = () => nowMs;
  console.log = (text) => {
    logs.push(String(text));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "1",
    FML_LAND_SCAN_INTERVAL_SECONDS: "900",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?fml-land-cycle-test=${Date.now()}`);
    const requestLog = [];
    let currentSync = {
      ...makeSync({}, 0),
      fmlTot: {
        fmlLand: {
          landMap: {
            501: { flwId: 23001, lvl: 2, matureFlwCnt: 2 },
            502: { flwId: 23002, lvl: 2, matureFlwCnt: 0 },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.fml.enter") return raw(currentSync);
        if (iface === "gs.fmlLand.harvest") {
          assert.deepEqual(args, { landIds: [501] });
          currentSync = {
            ...currentSync,
            fmlTot: {
              fmlLand: {
                landMap: {
                  501: { flwId: 23001, lvl: 2, matureFlwCnt: 0 },
                  502: { flwId: 23002, lvl: 2, matureFlwCnt: 0 },
                },
              },
            },
          };
          return raw({
            fmlTot: {
              fmlLand: {
                landMap: {
                  501: { flwId: 23001, lvl: 2, matureFlwCnt: 0 },
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const first = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);
    nowMs += 5 * 60 * 1000;
    const second = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", first, 2);

    assert.equal(requestLog.filter((item) => item.iface === "gs.fml.enter").length, 1);
    assert.equal(requestLog.filter((item) => item.iface === "gs.fmlLand.harvest").length, 1);
    assert.equal(second.fmlTot.fmlLand.landMap[501].matureFlwCnt, 0);
    assert.equal(second.fmlTot.fmlLand.landMap[502].matureFlwCnt, 0);

    const scanLog = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.step === "fmlLandScan");
    assert.deepEqual(scanLog.rows, [
      {
        landId: 501,
        flowerId: 23001,
        lvl: 2,
        matureFlwCnt: 2,
        estimatedMatureFlwCnt: 0,
        displayMatureFlwCnt: 2,
        stock: 10,
        canHarvest: true,
        matureSource: "server-matureFlwCnt",
        statusText: "可收获",
      },
      {
        landId: 502,
        flowerId: 23002,
        lvl: 2,
        matureFlwCnt: 0,
        estimatedMatureFlwCnt: 0,
        displayMatureFlwCnt: 0,
        stock: 10,
        canHarvest: false,
        matureSource: "missing-last-calc-time",
        statusText: "暂无成熟花朵",
      },
    ]);

    const statusHtml = fs.readFileSync(path.join(outDir, "garden-status.html"), "utf8");
    assert.match(statusHtml, /公会土地状态/);
    assert.match(statusHtml, /<td>501<\/td>/);
    assert.match(statusHtml, /<td>23001<\/td>/);
    assert.match(statusHtml, /<td>502<\/td>/);
    assert.match(statusHtml, /暂无成熟花朵/);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle harvests cached guild land maturity without waiting for the next scan window", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-fml-land-cached-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  let nowMs = Date.parse("2026-06-17T12:00:00.000Z");
  Date.now = () => nowMs;
  console.log = () => {};
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "1",
    FML_LAND_SCAN_INTERVAL_SECONDS: "900",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?fml-land-cached-cycle-test=${Date.now()}`);
    const requestLog = [];
    let currentSync = {
      ...makeSync({}, 0),
      fmlTot: {
        fmlLand: {
          landMap: {
            503: { flwId: 23001, lvl: 2, matureFlwCnt: 0 },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.fml.enter") return raw(currentSync);
        if (iface === "gs.fmlLand.harvest") {
          assert.deepEqual(args, { landIds: [503] });
          currentSync = {
            ...currentSync,
            fmlTot: {
              fmlLand: {
                landMap: {
                  503: { flwId: 23001, lvl: 2, matureFlwCnt: 0 },
                },
              },
            },
          };
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const first = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);
    nowMs += 5 * 60 * 1000;
    currentSync = {
      ...first,
      fmlTot: {
        fmlLand: {
          landMap: {
            503: { flwId: 23001, lvl: 2, matureFlwCnt: 2 },
          },
        },
      },
    };

    const second = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 2);

    assert.equal(requestLog.filter((item) => item.iface === "gs.fml.enter").length, 2);
    assert.equal(requestLog.filter((item) => item.iface === "gs.fmlLand.harvest").length, 1);
    assert.equal(second.fmlTot.fmlLand.landMap[503].matureFlwCnt, 0);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle hires one world recommended player for an idle pearl place", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-pearl-hire-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:30:00.000Z");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ pearlHireItemReserveCount: 6 }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "1",
    PEARL_MAX_HIRES_PER_CYCLE: "1",
    PEARL_HIRE_ITEM_ID: "9001",
    PEARL_HIRE_TIME_SECONDS: "3600",
    PEARL_GATHER_CD_SECONDS: "600",
    PEARL_REST_TIME_SECONDS: "1800",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?pearl-hire-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = {
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          bag: {
            7: 99,
            23001: 0,
            9001: 6,
          },
        },
      },
      pearlTot: {
        pearl: {
          recvDailyDate: "2026-06-15T00:00:00.000Z",
        },
        placeMap: {
          1: {
            placeId: 1,
          },
        },
        recommendList: [],
        otherHireMap: {},
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  9001: 8,
                },
              },
            },
          });
        }
        if (iface === "gs.pearl.recvDailyFree") {
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  9001: 2,
                },
              },
            },
            pearlTot: {
              pearl: {
                recvDailyDate: "2026-06-16T02:30:00.000Z",
              },
            },
          });
        }
        if (iface === "gs.pearl.getRecommendList") {
          return raw({
            pearlTot: {
              recommendList: [7001, 7002],
              recommendUserMap: {
                7001: {
                  nickName: "小花匠",
                },
              },
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearl.getHireStateByUids") {
          assert.deepEqual(args, { uids: [7001, 7002] });
          return raw({
            pearlTot: {
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearlPlace.hire") {
          assert.deepEqual(args, { placeId: 1, dstUid: 7001 });
          return raw({
            pearlTot: {
              placeMap: {
                1: {
                  placeId: 1,
                  laborUid: 7001,
                  laborEndTime: "2026-06-16T03:30:00.000Z",
                  everyMakeNum: 2,
                  recvCnt: 0,
                  surplusRecvNum: 0,
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.pearl.recvDailyFree",
        "gs.pearl.getRecommendList",
        "gs.pearl.getHireStateByUids",
        "gs.pearlPlace.hire",
      ],
    );
    assert.equal(result.pearlTot.placeMap[1].laborUid, 7001);
    assert.equal(result.$usrTot.data.bag[9001], 7);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.pearlHireCount, 1);
    assert.equal(statusJson.pearl.hireSource, "worldRecommend");
    assert.equal(statusJson.pearl.placeRows[0].laborUid, 7001);
    assert.equal(statusJson.pearl.placeRows[0].laborNickname, "小花匠");
    assert.equal(statusJson.pearl.placeRows[0].laborDisplayText, "小花匠 (7001)");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle retries the next pearl candidate in the same place after an amulet block", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-pearl-amulet-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:30:00.000Z");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ pearlHireItemReserveCount: 6 }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "1",
    PEARL_MAX_HIRES_PER_CYCLE: "2",
    PEARL_HIRE_ITEM_ID: "9001",
    PEARL_HIRE_TIME_SECONDS: "3600",
    PEARL_GATHER_CD_SECONDS: "600",
    PEARL_REST_TIME_SECONDS: "1800",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?pearl-amulet-retry=${Date.now()}`);
    const requestLog = [];
    const baseSync = {
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 1000000,
          nextExp: 10000000,
          bag: {
            7: 99,
            23001: 0,
            9001: 8,
          },
        },
      },
      pearlTot: {
        pearl: {
          recvDailyDate: "2026-06-16T00:00:00.000Z",
        },
        placeMap: {
          1: {
            placeId: 1,
          },
        },
        recommendList: [],
        otherHireMap: {},
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.pearl.getRecommendList") {
          return raw({
            pearlTot: {
              recommendList: [7001, 7002],
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearl.getHireStateByUids") {
          assert.deepEqual(args, { uids: [7001, 7002] });
          return raw({
            pearlTot: {
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearlPlace.hire") {
          const hireAttempt = requestLog.filter((item) => item.iface === iface).length;
          if (hireAttempt === 1) {
            assert.deepEqual(args, { placeId: 1, dstUid: 7001 });
            return raw({
              $ext: {
                iv: 1,
              },
            });
          }
          assert.deepEqual(args, { placeId: 1, dstUid: 7002 });
          return raw({
            pearlTot: {
              placeMap: {
                1: {
                  placeId: 1,
                  laborUid: 7002,
                  laborEndTime: "2026-06-16T03:30:00.000Z",
                  everyMakeNum: 2,
                  recvCnt: 0,
                  surplusRecvNum: 0,
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const pearlHireDoneLogs = [];
    const originalConsoleLog = console.log;
    let result;
    try {
      console.log = (message) => {
        try {
          const entry = JSON.parse(String(message));
          if (entry?.step === "pearlHireDone") pearlHireDoneLogs.push(entry);
        } catch {
          // Ignore non-JSON logs emitted by unrelated cycle steps.
        }
      };
      result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);
    } finally {
      console.log = originalConsoleLog;
    }
    const hireRequests = requestLog.filter((item) => item.iface === "gs.pearlPlace.hire");

    assert.deepEqual(hireRequests.map((item) => item.args), [
      { placeId: 1, dstUid: 7001 },
      { placeId: 1, dstUid: 7002 },
    ]);
    assert.equal(result.pearlTot.placeMap[1].laborUid, 7002);
    assert.equal(result.$usrTot.data.bag[9001], 6);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.pearlHireCount, 1);
    assert.deepEqual(
      pearlHireDoneLogs.map((entry) => entry.outcome),
      ["amulet-blocked", "hired"],
    );
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle refreshes pearl state when login sync has no pearlTot", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-pearl-refresh-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:30:00.000Z");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ pearlHireItemReserveCount: 6 }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "1",
    PEARL_MAX_HIRES_PER_CYCLE: "1",
    PEARL_HIRE_ITEM_ID: "9001",
    PEARL_HIRE_TIME_SECONDS: "3600",
    PEARL_GATHER_CD_SECONDS: "600",
    PEARL_REST_TIME_SECONDS: "1800",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?pearl-refresh-cycle-test=${Date.now()}`);
    const requestLog = [];
    const baseSync = {
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          bag: {
            7: 99,
            23001: 0,
            9001: 6,
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(baseSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  9001: 8,
                },
              },
            },
          });
        }
        if (iface === "gs.pearl.refresh") {
          return raw({
            pearlTot: {
              pearl: {
                recvDailyDate: "2026-06-15T00:00:00.000Z",
              },
              placeMap: {
                1: {
                  placeId: 1,
                },
              },
              recommendList: [],
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearl.recvDailyFree") {
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  9001: 2,
                },
              },
            },
            pearlTot: {
              pearl: {
                recvDailyDate: "2026-06-16T02:30:00.000Z",
              },
            },
          });
        }
        if (iface === "gs.pearl.getRecommendList") {
          return raw({
            pearlTot: {
              recommendList: [8001],
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearl.getHireStateByUids") {
          assert.deepEqual(args, { uids: [8001] });
          return raw({
            pearlTot: {
              otherHireMap: {},
            },
          });
        }
        if (iface === "gs.pearlPlace.hire") {
          assert.deepEqual(args, { placeId: 1, dstUid: 8001 });
          return raw({
            pearlTot: {
              placeMap: {
                1: {
                  placeId: 1,
                  laborUid: 8001,
                  laborEndTime: "2026-06-16T03:30:00.000Z",
                  everyMakeNum: 2,
                  recvCnt: 0,
                  surplusRecvNum: 0,
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", baseSync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.pearl.refresh",
        "gs.pearl.recvDailyFree",
        "gs.pearl.getRecommendList",
        "gs.pearl.getHireStateByUids",
        "gs.pearlPlace.hire",
      ],
    );
    assert.equal(result.pearlTot.placeMap[1].laborUid, 8001);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle records water restored before auto watering consumes it", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-flow-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T10:10:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-flow-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = {
      1001: seeded,
      1002: seeded,
    };
    let waterBase = 8;
    let waterLems = Date.parse("2026-06-16T10:06:00.000Z");
    let displayedWater = 10;
    const buildSync = () => ({
      $usrTot: {
        data: {
          cTime: "2026-06-16T09:00:00.000Z",
          bag: {
            7: waterBase,
            23001: 2,
          },
          itemExtMap: {
            7: {
              lems: waterLems,
              cd: 120000,
              resetNum: 65,
            },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 2,
            cTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: { ...landMap },
        },
      },
    });
    let currentSync = buildSync();
    const ws = {
      async request(iface, args) {
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentSync);
        if (iface === "gs.usrLand.water") {
          landMap[args.landId] = growing;
          displayedWater -= 1;
          waterBase = displayedWater;
          waterLems = nowMs;
          currentSync = buildSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterDropText, "8/65");
    assert.equal(statusJson.summary.waterDropFlowText, "浇水前 10/65，自然恢复 2；本轮自动浇水消耗 2；结束 8/65");
    assert.deepEqual(
      {
        before: statusJson.summary.waterDropBeforeWaterText,
        after: statusJson.summary.waterDropText,
        watered: statusJson.summary.waterDropWateredCount,
        serverWaterDropCount: statusJson.waterDecision.serverWaterDropCount,
        decisionWaterDropCount: statusJson.waterDecision.decisionWaterDropCount,
        restored: statusJson.summary.waterDropRestoredBeforeWater,
      },
      {
        before: "10/65",
        after: "8/65",
        watered: 2,
        serverWaterDropCount: 10,
        decisionWaterDropCount: 10,
        restored: 2,
      },
    );
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waters existing seeded land before planting new empty land", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-before-plant-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-before-plant-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let currentSync = makeSync({ 1001: seeded, 1002: {} }, 5);
    currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 1;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          currentSync = makeSync({ 1001: seeded, 1002: seeded }, 5);
          currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 1;
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          assert.deepEqual(args, { landId: 1001 });
          currentSync = makeSync({ 1001: growing, 1002: {} }, 5);
          currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 1;
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plant"), false);
    assert.equal(result.usrLandTot.usrLand.landMap[1001].state, 2);
    assert.deepEqual(result.usrLandTot.usrLand.landMap[1002], {});
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 1);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants and waters an eligible land group as a whole", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-plant-water-cap-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?plant-water-cap-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let currentSync = makeSync({ 1001: {}, 1002: {} }, 5);
    currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 2;
    const requestLog = [];
    const setLand = (landId, value) => {
      const waterBefore = currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP];
      currentSync = makeSync({
        ...currentSync.usrLandTot.usrLand.landMap,
        [landId]: value,
      }, 5);
      currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = Math.max(0, waterBefore - (value === growing ? 1 : 0));
      return currentSync;
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          return raw(setLand(args.landId, seeded));
        }
        if (iface === "gs.usrLand.water") {
          return raw(setLand(args.landId, growing));
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);
    const landActions = requestLog
      .filter((entry) => entry.iface === "gs.usrLand.plant" || entry.iface === "gs.usrLand.water")
      .map((entry) => [entry.iface, entry.args]);

    assert.deepEqual(landActions, [
      ["gs.usrLand.plant", { landId: 1001, flowerId: 23001 }],
      ["gs.usrLand.plant", { landId: 1002, flowerId: 23001 }],
      ["gs.usrLand.water", { landId: 1001 }],
      ["gs.usrLand.water", { landId: 1002 }],
    ]);
    assert.equal(result.usrLandTot.usrLand.landMap[1001].state, 2);
    assert.equal(result.usrLandTot.usrLand.landMap[1002].state, 2);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 2);
    assert.equal(statusJson.summary.wateredCount, 2);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps each sixteen-land group on the same flower while planting one by one", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-sixteen-land-group-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeTwoFlowerSync = (landMap, waterDrops, counts) => {
    const sync = makeSync(landMap, counts[23001] ?? 0);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.$usrTot.data.bag[23001] = counts[23001] ?? 0;
    sync.$usrTot.data.bag[23002] = counts[23002] ?? 0;
    sync.cultivateTot.cultivateMap[23002] = {
      flowerId: 23002,
      lvl: 2,
      cTime: "2026-06-16T00:00:00.000Z",
    };
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?sixteen-land-group-cycle-test=${Date.now()}`);
    let waterDrops = 16;
    const seededFor = (flowerId) => ({ state: 1, flowerId, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 });
    const growingFor = (flowerId) => ({ ...seededFor(flowerId), state: 2 });
    let landMap = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [1001 + index, {}]));
    let currentSync = makeTwoFlowerSync(landMap, waterDrops, { 23001: 0, 23002: 1 });
    const requestLog = [];
    const syncAfterFirstPlantCounts = { 23001: 10, 23002: 0 };
    const syncCurrent = (counts = syncAfterFirstPlantCounts) => makeTwoFlowerSync({ ...landMap }, waterDrops, counts);
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = seededFor(args.flowerId);
          currentSync = syncCurrent();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = growingFor(flowerId);
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = syncCurrent();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);
    const plantCalls = requestLog
      .filter((entry) => entry.iface === "gs.usrLand.plant")
      .map((entry) => entry.args);

    assert.deepEqual(plantCalls, [
      ...Array.from({ length: 16 }, (_, index) => ({ landId: 1001 + index, flowerId: 23001 })),
    ]);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle maps sorted land groups to sorted plant candidates", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-land-group-candidate-map-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T10:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeThreeFlowerSync = (landMap, waterDrops) => {
    const sync = makeSync(landMap, 10);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.$usrTot.data.bag[23001] = 10;
    sync.$usrTot.data.bag[23002] = 20;
    sync.$usrTot.data.bag[23003] = 30;
    sync.cultivateTot.cultivateMap[23002] = {
      flowerId: 23002,
      lvl: 2,
      cTime: "2026-06-16T00:00:00.000Z",
    };
    sync.cultivateTot.cultivateMap[23003] = {
      flowerId: 23003,
      lvl: 2,
      cTime: "2026-06-16T00:00:00.000Z",
    };
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?land-group-candidate-map-cycle-test=${Date.now()}`);
    let waterDrops = 32;
    const maturitySecondsByFlower = new Map([[23001, 55], [23002, 110], [23003, 165]]);
    const seededFor = (flowerId) => ({
      state: 1,
      flowerId,
      lvl: 2,
      nextTime: new Date(Date.now() + (maturitySecondsByFlower.get(Number(flowerId)) || 55) * 1000).toISOString(),
      harvestCnt: 0,
    });
    const growingFor = (flowerId) => ({ ...seededFor(flowerId), state: 2 });
    let landMap = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [1001 + index, {}]));
    let currentSync = makeThreeFlowerSync(landMap, waterDrops);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = seededFor(args.flowerId);
          currentSync = makeThreeFlowerSync({ ...landMap }, waterDrops);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = growingFor(flowerId);
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeThreeFlowerSync({ ...landMap }, waterDrops);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);
    const plantCalls = requestLog
      .filter((entry) => entry.iface === "gs.usrLand.plant")
      .map((entry) => entry.args);

    assert.deepEqual(plantCalls, [
      ...Array.from({ length: 16 }, (_, index) => ({ landId: 1001 + index, flowerId: 23001 })),
      ...Array.from({ length: 16 }, (_, index) => ({ landId: 1017 + index, flowerId: 23002 })),
    ]);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 32);
    assert.equal(statusJson.summary.wateredCount, 32);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waits for enough water before starting a full sixteen-land group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-wait-sixteen-land-water-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?wait-sixteen-land-water-cycle-test=${Date.now()}`);
    let currentSync = makeSync(
      Object.fromEntries(Array.from({ length: 16 }, (_, index) => [1001 + index, {}])),
      100,
    );
    currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 5;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plant"), false);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.water"), false);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle plants and waters the final partial land group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-final-partial-land-group-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeCurrentSync = (landMap, waterDrops) => {
    const sync = makeSync(landMap, 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?final-partial-land-group-cycle-test=${Date.now()}`);
    const fullGroupSize = 16;
    const finalPartialStartLandId = 1017;
    const finalPartialLandIds = makeLandIds(finalPartialStartLandId, 11);
    let waterDrops = finalPartialLandIds.length;
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries([
      ...makeLandEntries(1001, fullGroupSize, growing),
      ...makeLandEntries(finalPartialStartLandId, finalPartialLandIds.length, {}),
    ]);
    let currentSync = makeCurrentSync(landMap, waterDrops);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = makeCurrentSync({ ...landMap }, waterDrops);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync({ ...landMap }, waterDrops);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.plant")
        .map((entry) => entry.args),
      finalPartialLandIds.map((landId) => ({ landId, flowerId: 23001 })),
    );
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.water")
        .map((entry) => entry.args),
      finalPartialLandIds.map((landId) => ({ landId })),
    );
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.step === "plantLandGroupSelect");
    assert.equal(parsedLogs[0]?.actualGroupSize, finalPartialLandIds.length);
    assert.equal(parsedLogs[0]?.maxGroupSize, fullGroupSize);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, finalPartialLandIds.length);
    assert.equal(statusJson.summary.wateredCount, finalPartialLandIds.length);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps filling a started final partial group when server maturity is shorter than local config", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-final-partial-server-maturity-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-22T04:33:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const targetFlowerId = 23280;
  const makeCurrentSync = (landMap, waterDrops) => {
    const sync = makeSync(landMap, 1000);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.$usrTot.data.bag[targetFlowerId] = 0;
    sync.cultivateTot.cultivateMap[targetFlowerId] = {
      flowerId: targetFlowerId,
      lvl: 17,
      cTime: "2026-05-23T14:50:22.000Z",
    };
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?final-partial-server-maturity-cycle-test=${Date.now()}`);
    const finalPartialStartLandId = 1049;
    const finalPartialLandIds = makeLandIds(finalPartialStartLandId, 8);
    let waterDrops = finalPartialLandIds.length;
    const serverNextTime = new Date(Date.now() + 720 * 1000).toISOString();
    const seededFor = (flowerId) => ({ state: 1, flowerId, lvl: 17, nextTime: serverNextTime, harvestCnt: 0 });
    const growingFor = (flowerId) => ({ ...seededFor(flowerId), state: 2 });
    let landMap = Object.fromEntries([
      ...makeLandEntries(1001, 48, { state: 2, flowerId: 23001, lvl: 2, nextTime: "2026-06-22T05:00:00.000Z", harvestCnt: 0 }),
      ...makeLandEntries(finalPartialStartLandId, finalPartialLandIds.length, {}),
    ]);
    let currentSync = makeCurrentSync(landMap, waterDrops);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = seededFor(args.flowerId);
          currentSync = makeCurrentSync({ ...landMap }, waterDrops);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = growingFor(flowerId);
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeCurrentSync({ ...landMap }, waterDrops);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.plant")
        .map((entry) => entry.args),
      finalPartialLandIds.map((landId) => ({ landId, flowerId: targetFlowerId })),
    );
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.water")
        .map((entry) => entry.args),
      finalPartialLandIds.map((landId) => ({ landId })),
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, finalPartialLandIds.length);
    assert.equal(statusJson.summary.wateredCount, finalPartialLandIds.length);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

for (const finalPartialLandCount of [2, 7, 15]) {
  test(`runGardenCycle waits for enough water before final partial land group (${finalPartialLandCount} lands)`, async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-wait-final-partial-water-"));
    const oldEnv = { ...process.env };
    const oldLog = console.log;
    const logs = [];
    console.log = (line = "") => {
      logs.push(String(line));
    };
    assignCycleEnv({
      STATUS_DOC_DIR: outDir,
      AUTO_SUBMIT_SPECIAL_ORDERS: "0",
      AUTO_HANDLE_TEAM_ORDERS: "0",
      AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
      AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
      AUTO_HANDLE_FLOWER_RACK: "0",
      AUTO_HANDLE_PEARL: "0",
    });

    try {
      const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?wait-final-partial-water-cycle-test=${Date.now()}-${finalPartialLandCount}`);
      const fullGroupSize = 16;
      const finalPartialStartLandId = 1017;
      const finalPartialLandIds = makeLandIds(finalPartialStartLandId, finalPartialLandCount);
      const insufficientWaterDrops = finalPartialLandIds.length - 1;
      const growing = { state: 2, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
      const landMap = Object.fromEntries([
        ...makeLandEntries(1001, fullGroupSize, growing),
        ...makeLandEntries(finalPartialStartLandId, finalPartialLandIds.length, {}),
      ]);
      const sync = makeSync(landMap, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = insufficientWaterDrops;
      const requestLog = [];
      const ws = {
        async request(iface, args) {
          requestLog.push({ iface, args });
          if (iface === "gs.usrLand.refresh") return raw(sync);
          if (iface === "gs.usr.heartTick") return raw({});
          if (iface === "gs.usr.lazySync") return raw({});
          throw new Error(`unexpected iface ${iface}`);
        },
      };

      await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

      assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plant"), false);
      assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.water"), false);
      const parsedLogs = logs
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const emptySkip = parsedLogs.find((entry) => entry.step === "plantEmptySkip");
      assert.equal(emptySkip?.reason, "waiting-water-for-land-group");
      assert.equal(emptySkip?.waterBlockedGroupCount, 1);
      assert.equal(emptySkip?.waterBlockedGroups?.[0]?.actualGroupSize, finalPartialLandIds.length);
      assert.equal(emptySkip?.waterBlockedGroups?.[0]?.requiredWaterCount, finalPartialLandIds.length);
      assert.equal(emptySkip?.waterBlockedGroups?.[0]?.waterDropCount, insufficientWaterDrops);
      const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
      assert.equal(statusJson.summary.plantedCount, 0);
      assert.equal(statusJson.summary.wateredCount, 0);
    } finally {
      console.log = oldLog;
      process.env = oldEnv;
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
}

test("runGardenCycle finishes a selected sixteen-land group even when single calls cross the planting window", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-sixteen-land-window-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  let nowMs = Date.parse("2026-06-16T10:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeTwoFlowerSync = (landMap, waterDrops, counts) => {
    const sync = makeSync(landMap, counts[23001] ?? 0);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.$usrTot.data.bag[23001] = counts[23001] ?? 0;
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?sixteen-land-window-cycle-test=${Date.now()}`);
    let waterDrops = 16;
    const seededFor = (flowerId) => ({ state: 1, flowerId, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 });
    const growingFor = (flowerId) => ({ ...seededFor(flowerId), state: 2 });
    let landMap = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [1001 + index, {}]));
    let currentSync = makeTwoFlowerSync(landMap, waterDrops, { 23001: 100 });
    const requestLog = [];
    const syncCurrent = () => makeTwoFlowerSync({ ...landMap }, waterDrops, { 23001: 100 });
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args, atMs: nowMs });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = seededFor(args.flowerId);
          currentSync = syncCurrent();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = growingFor(flowerId);
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = syncCurrent();
          if (args.landId === 1001) nowMs += 61_000;
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.plant")
        .map((entry) => entry.args),
      makeLandIds(1001, 16).map((landId) => ({ landId, flowerId: 23001 })),
    );
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.water")
        .map((entry) => entry.args),
      makeLandIds(1001, 16).map((landId) => ({ landId })),
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 16);
    assert.equal(statusJson.summary.wateredCount, 16);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not repair a mixed sixteen-land group one land at a time", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-mixed-sixteen-land-group-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  const makeTwoFlowerSync = (landMap, waterDrops, counts) => {
    const sync = makeSync(landMap, counts[23001] ?? 0);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
    sync.$usrTot.data.bag[23001] = counts[23001] ?? 0;
    sync.$usrTot.data.bag[23002] = counts[23002] ?? 0;
    sync.cultivateTot.cultivateMap[23002] = {
      flowerId: 23002,
      lvl: 2,
      cTime: "2026-06-16T00:00:00.000Z",
    };
    return sync;
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?mixed-sixteen-land-group-cycle-test=${Date.now()}`);
    let waterDrops = 1;
    const seededFor = (flowerId) => ({ state: 1, flowerId, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 });
    const growingFor = (flowerId) => ({ ...seededFor(flowerId), state: 2 });
    const existingRows = Array.from({ length: 15 }, (_, index) => [
      1001 + index,
      growingFor(index < 10 ? 23001 : 23002),
    ]);
    let landMap = Object.fromEntries([
      ...existingRows,
      [1016, {}],
      ...Array.from({ length: 16 }, (_, index) => [1017 + index, {}]),
    ]);
    let currentSync = makeTwoFlowerSync(landMap, waterDrops, { 23001: 100, 23002: 0 });
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = seededFor(args.flowerId);
          currentSync = makeTwoFlowerSync({ ...landMap }, waterDrops, { 23001: 100, 23002: 0 });
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = growingFor(flowerId);
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = makeTwoFlowerSync({ ...landMap }, waterDrops, { 23001: 100, 23002: 0 });
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.plant")
        .map((entry) => entry.args),
      [],
    );
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.water")
        .map((entry) => entry.args),
      [],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle reports no eligible empty land when every group is blocked by maturity window", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-no-eligible-land-group-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T10:00:00.000Z");
  Date.now = () => nowMs;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?blocked-sixteen-land-group-cycle-test=${Date.now()}`);
    const growing = (nextTime) => ({
      state: 2,
      flowerId: 23001,
      lvl: 2,
      nextTime,
      harvestCnt: 0,
    });
    const landMap = Object.fromEntries([
      [1001, growing(new Date(nowMs + 10 * 60 * 1000).toISOString())],
      [1002, growing(new Date(nowMs + 12 * 60 * 1000).toISOString())],
      ...Array.from({ length: 14 }, (_, index) => [1003 + index, {}]),
    ]);
    let currentSync = makeSync(landMap, 100);
    currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 65;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plant"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    const groupSkip = parsedLogs.find((entry) => entry.step === "plantLandGroupSkip");
    assert.equal(groupSkip?.reason, "waiting-empty-for-land-group");
    const emptySkip = parsedLogs.find((entry) => entry.step === "plantEmptySkip");
    assert.equal(emptySkip?.reason, "waiting-empty-for-land-group");
    assert.equal(emptySkip?.emptyLandCount, 14);
    assert.equal(emptySkip?.blockedGroupCount, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.plantingRule.groupMatureWindowSeconds, 60);
    assert.equal(statusJson.plantingRule.keepGroupMatureWindow, true);
    assert.equal(statusJson.plantingBlockers.length, 1);
    assert.equal(statusJson.plantingBlockers[0].reason, "waiting-empty-for-land-group");
    assert.equal(statusJson.plantingBlockers[0].emptyLandCount, 14);
    assert.equal(statusJson.plantingBlockers[0].waterDropCount, 65);
    assert.equal(statusJson.summary.plantingBlockerCount, 1);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not plant while seeded backlog remains even when water is available", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-seeded-backlog-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?seeded-backlog-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    let currentSync = makeSync({ 1001: seeded, 1002: {} }, 5);
    currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 65;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.waterBatch") return raw(currentSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plantBatch"), false);
    assert.equal(result.usrLandTot.usrLand.landMap[1001].state, 1);
    assert.deepEqual(result.usrLandTot.usrLand.landMap[1002], {});
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 0);
    assert.equal(statusJson.summary.wateredCount, 0);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waters each seeded land group as a whole before planting another group", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-partial-water-batch-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?partial-water-batch-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = { 1001: seeded, 1002: seeded, 1017: {}, 1018: {} };
    let currentSync = makeSync(landMap, 5);
    currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 65;
    const requestLog = [];
    const setSync = () => {
      currentSync = makeSync({ ...landMap }, 5);
      currentSync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 65;
      return currentSync;
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = seeded;
          return raw(setSync());
        }
        if (iface === "gs.usrLand.water") {
          if (landMap[args.landId]?.state === 1) landMap[args.landId] = growing;
          return raw(setSync());
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);
    const waterCalls = requestLog
      .filter((entry) => entry.iface === "gs.usrLand.water")
      .map((entry) => entry.args.landId);
    const plantCalls = requestLog
      .filter((entry) => entry.iface === "gs.usrLand.plant")
      .map((entry) => entry.args);

    assert.deepEqual(waterCalls, [1001, 1002, 1017, 1018]);
    assert.deepEqual(plantCalls, [
      { landId: 1017, flowerId: 23001 },
      { landId: 1018, flowerId: 23001 },
    ]);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.waterBatch"), false);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.plantBatch"), false);
    assert.equal(result.usrLandTot.usrLand.landMap[1001].state, 2);
    assert.equal(result.usrLandTot.usrLand.landMap[1002].state, 2);
    assert.equal(result.usrLandTot.usrLand.landMap[1017].state, 2);
    assert.equal(result.usrLandTot.usrLand.landMap[1018].state, 2);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.plantedCount, 2);
    assert.equal(statusJson.summary.wateredCount, 4);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle receives free water worker drops when current water is below threshold", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-free-water-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = new Date(2026, 5, 16, 11, 30, 0).getTime();
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FREE_WATER: "1",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?free-water-cycle-test=${oldNow()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-16T10:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 12;
    let freeWater = {
      recvIdx: [],
      rTime: new Date(nowMs).toISOString(),
    };
    const setSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.freeWater = freeWater;
      return sync;
    };
    let currentSync = setSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.freeWater.recv") {
          assert.deepEqual(args, { idx: 0 });
          waterDrops += 30;
          freeWater = {
            recvIdx: [0],
            rTime: new Date(nowMs).toISOString(),
          };
          currentSync = setSync();
          return raw({
            freeWater,
            $usrTot: { itemAddChg: { itemMap: { [ITEM_IDS.WATER_DROP]: 30 } } },
          });
        }
        if (iface === "gs.usrLand.plant") {
          landMap[args.landId] = { ...seeded, flowerId: args.flowerId };
          currentSync = setSync();
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.water") {
          const flowerId = landMap[args.landId]?.flowerId;
          if (flowerId) landMap[args.landId] = { ...growing, flowerId };
          waterDrops = Math.max(0, waterDrops - 1);
          currentSync = setSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((item) => item.iface === "gs.freeWater.recv"), true);
    assert.equal(result.$usrTot.data.bag[ITEM_IDS.WATER_DROP], 26);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.freeWaterReceivedCount, 1);
    assert.equal(statusJson.freeWater.receivedCountToday, 1);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle stops free water pass when receive advances before water drop sync", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-free-water-stale-sync-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const nowMs = Date.parse("2026-06-16T12:00:00.000Z");
  const logs = [];
  Date.now = () => nowMs;
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_FREE_WATER: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?free-water-stale-sync-cycle-test=${Date.now()}`);
    const landMap = Object.fromEntries(makeLandEntries(1001, 16, {}));
    let waterDrops = 12;
    let freeWater = {
      recvIdx: [],
      rTime: new Date(nowMs).toISOString(),
    };
    const setSync = () => {
      const sync = makeSync({ ...landMap }, 100);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      sync.freeWater = freeWater;
      return sync;
    };
    let currentSync = setSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.freeWater.recv") {
          freeWater = {
            recvIdx: [args.idx],
            rTime: new Date(nowMs).toISOString(),
          };
          currentSync = setSync();
          return raw({ freeWater });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.freeWater.recv").length, 1);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.plant"), false);
    assert.equal(requestLog.some((item) => item.iface === "gs.usrLand.water"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "waterDropSyncPending" && entry.source === "freeWater"), true);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.waterRefillBlockedReason, "water-drop-sync-pending");
    assert.equal(statusJson.summary.freeWaterActionCount, 1);
    assert.equal(statusJson.summary.freeWaterReceivedCount, 0);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle collects mature flower rack gold and shelves default Danqing porcelain vase art", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-flower-rack-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const settingsPath = path.join(outDir, "profile-settings.json");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ flowerRackTargetArtId: EXPECTED_DEFAULT_RACK_ART_ID }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    FLOWER_RACK_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?flower-rack-cycle-test=${Date.now()}`);
    const matureStart = new Date(nowMs - (12 * 240 + 60) * 1000).toISOString();
    const rackMap = Object.fromEntries(Array.from({ length: 6 }, (_, idx) => {
      const rackId = idx + 1;
      return [rackId, {
        rackId,
        iid: 300101,
        num: 12,
        sellStartTime: matureStart,
      }];
    }));
    const sync = {
      ...makeSync({}, 0),
      $flowerRackRecommendations: [{
        artId: EXPECTED_DEFAULT_RACK_ART_ID,
        label: "301722(丹青瓷瓶+轻紫大花葱+蓝叶苏铁+粉鹤芋)",
        vaseId: EXPECTED_DEFAULT_RACK_VASE_ID,
        vaseName: "丹青瓷瓶",
        flowerIds: EXPECTED_DEFAULT_RACK_FLOWER_IDS,
        flowers: [],
        salePrice: 872,
      }],
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      flowerRackTot: {
        flowerRackMap: rackMap,
      },
    };
    sync.$usrTot.data.bag[EXPECTED_DEFAULT_RACK_ART_ID] = 72;

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.flowerRack.recvSellMoney") {
          return raw({
            flowerRackTot: {
              flowerRackMap: {
                [args.rackId]: { rackId: args.rackId },
              },
            },
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.GOLD]: 120,
                },
              },
            },
          });
        }
        if (iface === "gs.flowerRack.sellOneKey") {
          return raw({
            flowerRackTot: {
              flowerRackMap: Object.fromEntries(
                Object.entries(args.sellMap).map(([id, pair]) => [id, {
                  rackId: Number(id),
                  iid: pair[0],
                  num: pair[1],
                  sellStartTime: new Date(nowMs).toISOString(),
                }]),
              ),
            },
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [EXPECTED_DEFAULT_RACK_ART_ID]: -Object.values(args.sellMap).reduce((sum, pair) => sum + pair[1], 0),
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.sellOneKey",
      ],
    );
    assert.deepEqual(requestLog.filter((item) => item.iface === "gs.flowerRack.sellOneKey").map((item) => item.args), [
      { sellMap: {
        1: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
        2: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
        3: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
        4: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
        5: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
        6: [EXPECTED_DEFAULT_RACK_ART_ID, 12],
      } },
    ]);
    assert.equal(TARGET_FLOWER_RACK_ART_ID, EXPECTED_DEFAULT_RACK_ART_ID);
    assert.equal(result.$usrTot.data.bag[EXPECTED_DEFAULT_RACK_ART_ID], 0);
    assert.equal(result.flowerRackTot.flowerRackMap[6].iid, EXPECTED_DEFAULT_RACK_ART_ID);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.flowerRackActionCount, 12);
    assert.equal(statusJson.summary.flowerRackGoldReceivedCount, 6);
    assert.equal(statusJson.summary.flowerRackShelvedCount, 6);
    assert.equal(statusJson.flowerRack.targetArt.artId, EXPECTED_DEFAULT_RACK_ART_ID);
    assert.deepEqual(statusJson.flowerRack.recommendedArts, sync.$flowerRackRecommendations);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle makes missing rack flower art and waits for inventory sync before shelving", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-flower-rack-make-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const settingsPath = path.join(outDir, "profile-settings.json");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ flowerRackTargetArtId: EXPECTED_DEFAULT_RACK_ART_ID }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    FLOWER_RACK_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?flower-rack-make-cycle-test=${Date.now()}`);
    const matureStart = new Date(nowMs - (12 * 240 + 60) * 1000).toISOString();
    const rackMap = Object.fromEntries(Array.from({ length: 6 }, (_, idx) => {
      const rackId = idx + 1;
      return [rackId, {
        rackId,
        iid: 300101,
        num: 12,
        sellStartTime: matureStart,
      }];
    }));
    const sync = {
      ...makeSync({}, 0),
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      flowerRackTot: {
        flowerRackMap: rackMap,
      },
    };
    Object.assign(sync.$usrTot.data.bag, {
      [EXPECTED_DEFAULT_RACK_ART_ID]: 60,
      [EXPECTED_DEFAULT_RACK_VASE_ID]: 12,
      23126: 12,
      23104: 12,
      23105: 12,
    });

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.flowerRack.recvSellMoney") {
          return raw({
            flowerRackTot: {
              flowerRackMap: {
                [args.rackId]: { rackId: args.rackId },
              },
            },
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.GOLD]: 120,
                },
              },
            },
          });
        }
        if (iface === "gs.flowerArt.makeFlowerArt") {
          assert.deepEqual(args, {
            vaseId: EXPECTED_DEFAULT_RACK_VASE_ID,
            flowersIds: EXPECTED_DEFAULT_RACK_FLOWER_IDS,
            num: 12,
          });
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [EXPECTED_DEFAULT_RACK_ART_ID]: 12,
                  [EXPECTED_DEFAULT_RACK_VASE_ID]: -12,
                  23126: -12,
                  23104: -12,
                  23105: -12,
                },
              },
            },
          });
        }
        if (iface === "gs.flowerRack.sell") {
          return raw({
            flowerRackTot: {
              flowerRackMap: {
                [args.rackId]: {
                  rackId: args.rackId,
                  iid: args.iid,
                  num: args.num,
                  sellStartTime: new Date(nowMs).toISOString(),
                },
              },
            },
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [args.iid]: -args.num,
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerRack.recvSellMoney",
        "gs.flowerArt.makeFlowerArt",
      ],
    );
    assert.equal(requestLog.some((item) => item.iface === "gs.flowerRack.sell"), false);
    assert.equal(result.$usrTot.data.bag[EXPECTED_DEFAULT_RACK_VASE_ID], 0);
    assert.equal(result.$usrTot.data.bag[23126], 0);
    assert.equal(result.$usrTot.data.bag[23104], 0);
    assert.equal(result.$usrTot.data.bag[23105], 0);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.flowerRackGoldReceivedCount, 6);
    assert.equal(statusJson.summary.flowerRackMakeActionCount, 1);
    assert.equal(statusJson.summary.flowerRackMadeCount, 12);
    assert.equal(statusJson.summary.flowerRackShelvedCount, 0);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not use unconfirmed rack flower art inventory when make response omits item deltas", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-flower-rack-local-items-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const settingsPath = path.join(outDir, "profile-settings.json");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ flowerRackTargetArtId: EXPECTED_DEFAULT_RACK_ART_ID }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    FLOWER_RACK_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?flower-rack-local-items-test=${Date.now()}`);
    const rackMap = Object.fromEntries(Array.from({ length: 6 }, (_, idx) => {
      const rackId = idx + 1;
      return [rackId, { rackId }];
    }));
    const sync = {
      ...makeSync({}, 0),
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      flowerRackTot: {
        flowerRackMap: rackMap,
      },
    };
    Object.assign(sync.$usrTot.data.bag, {
      [EXPECTED_DEFAULT_RACK_ART_ID]: 27,
      [EXPECTED_DEFAULT_RACK_VASE_ID]: 0,
      23126: 45,
      23104: 45,
      23105: 45,
    });

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.flowerArt.makeFlowerArt") {
          assert.deepEqual(args, {
            vaseId: EXPECTED_DEFAULT_RACK_VASE_ID,
            flowersIds: EXPECTED_DEFAULT_RACK_FLOWER_IDS,
            num: 45,
          });
          return raw({});
        }
        if (iface === "gs.flowerRack.sell") {
          return raw({
            flowerRackTot: {
              flowerRackMap: {
                [args.rackId]: {
                  rackId: args.rackId,
                  iid: args.iid,
                  num: args.num,
                  sellStartTime: new Date(nowMs).toISOString(),
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.flowerArt.makeFlowerArt",
      ],
    );
    assert.equal(requestLog.some((item) => item.iface === "gs.flowerRack.sell"), false);
    assert.equal(result.$usrTot.data.bag[EXPECTED_DEFAULT_RACK_ART_ID], 27);
    assert.equal(result.$usrTot.data.bag[23126], 0);
    assert.equal(result.$usrTot.data.bag[23104], 0);
    assert.equal(result.$usrTot.data.bag[23105], 0);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.flowerRack.targetArt.have, 27);
    assert.equal(statusJson.summary.flowerRackMakeActionCount, 1);
    assert.equal(statusJson.summary.flowerRackShelvedCount, 0);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle locally deducts logged water drops when water response keeps stale bag value", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-stale-bag-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T00:40:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-stale-bag-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-17T01:10:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let currentSync = {
      $usrTot: {
        data: {
          cTime: "2026-06-16T09:00:00.000Z",
          bag: {
            7: 181,
            23001: 2,
          },
          itemExtMap: {
            7: {
              lems: Date.parse("2026-06-17T00:30:00.000Z"),
              cd: 120000,
              resetNum: 65,
            },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 2,
            cTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: seeded,
            1002: seeded,
          },
        },
      },
    };
    let landMap = {
      1001: seeded,
      1002: seeded,
    };
    const staleWaterAfterSync = () => ({
      ...currentSync,
      $usrTot: {
        data: {
          ...currentSync.$usrTot.data,
          bag: {
            7: 181,
            23001: 2,
          },
          itemExtMap: {
            7: {
              lems: nowMs,
              cd: 120000,
              resetNum: 65,
            },
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: { ...landMap },
        },
      },
    });
    const ws = {
      async request(iface, args) {
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usrLand.water") {
          landMap[args.landId] = growing;
          currentSync = staleWaterAfterSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(result.$usrTot.data.bag[7], 179);
    assert.equal(statusJson.summary.waterDropText, "179/65");
    assert.equal(statusJson.summary.waterDropFlowText, "浇水前 181/65，自然恢复 0；本轮自动浇水消耗 2；结束 179/65");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle follows lower server water count from watering responses", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-server-count-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T00:45:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-server-count-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-17T01:10:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let waterDrops = 10;
    let landMap = {
      1001: seeded,
      1002: seeded,
    };
    const makeCurrentSync = () => {
      const sync = makeSync({ ...landMap }, 2);
      sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = waterDrops;
      return sync;
    };
    let currentSync = makeCurrentSync();
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.water") {
          landMap[args.landId] = growing;
          waterDrops = args.landId === 1001 ? 6 : 5;
          currentSync = makeCurrentSync();
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.water")
        .map((entry) => entry.args),
      [{ landId: 1001 }, { landId: 1002 }],
    );
    assert.equal(result.$usrTot.data.bag[ITEM_IDS.WATER_DROP], 5);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterDropText, "5/65");
    assert.equal(statusJson.summary.waterDropWateredCount, 2);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle clears local flower stock when rack make reports item shortage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-flower-rack-make-shortage-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const settingsPath = path.join(outDir, "profile-settings.json");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ flowerRackTargetArtId: EXPECTED_DEFAULT_RACK_ART_ID }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    FLOWER_RACK_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?flower-rack-make-shortage-test=${Date.now()}`);
    const rackMap = Object.fromEntries(Array.from({ length: 6 }, (_, idx) => {
      const rackId = idx + 1;
      return [rackId, { rackId }];
    }));
    const sync = {
      ...makeSync({}, 0),
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      flowerRackTot: {
        flowerRackMap: rackMap,
      },
    };
    Object.assign(sync.$usrTot.data.bag, {
      [EXPECTED_DEFAULT_RACK_ART_ID]: 60,
      [EXPECTED_DEFAULT_RACK_VASE_ID]: 12,
      23126: 12,
      23104: 12,
      23105: 12,
    });

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.flowerArt.makeFlowerArt") {
          return {
            m: {
              code: 301,
              param: { iid: 23105 },
            },
          };
        }
        if (iface === "gs.flowerRack.sell") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      ifacesWithoutLazySync(requestLog),
      [
        "gs.usrLand.refresh",
        "gs.usr.heartTick",
        "gs.flowerArt.makeFlowerArt",
      ],
    );
    assert.equal(result.$usrTot.data.bag[23105], 0);
    assert.equal(requestLog.some((item) => item.iface === "gs.flowerRack.sell"), false);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle clears local rack art stock when sell reports item shortage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-flower-rack-sell-shortage-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  const settingsPath = path.join(outDir, "profile-settings.json");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({ flowerRackTargetArtId: EXPECTED_DEFAULT_RACK_ART_ID }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    FLOWER_RACK_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?flower-rack-sell-shortage-test=${Date.now()}`);
    const rackMap = Object.fromEntries(Array.from({ length: 6 }, (_, idx) => {
      const rackId = idx + 1;
      return [rackId, { rackId }];
    }));
    const sync = {
      ...makeSync({}, 0),
      videoDouble: {
        eTime: new Date(nowMs + 10 * 60 * 1000).toISOString(),
      },
      flowerRackTot: {
        flowerRackMap: rackMap,
      },
    };
    sync.$usrTot.data.bag[EXPECTED_DEFAULT_RACK_ART_ID] = 72;

    let sellCount = 0;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.flowerRack.sellOneKey") {
          sellCount += 1;
          if (sellCount === 1) {
            return {
              m: {
                code: 301,
                param: { iid: EXPECTED_DEFAULT_RACK_ART_ID },
              },
            };
          }
          return raw({
            flowerRackTot: {
              flowerRackMap: Object.fromEntries(
                Object.entries(args.sellMap).map(([id, pair]) => [id, {
                  rackId: Number(id),
                  iid: pair[0],
                  num: pair[1],
                  sellStartTime: new Date(nowMs).toISOString(),
                }]),
              ),
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(requestLog.filter((item) => item.iface === "gs.flowerRack.sellOneKey").length, 1);
    assert.equal(result.$usrTot.data.bag[EXPECTED_DEFAULT_RACK_ART_ID], 0);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle ignores implausible oi.bd water zero from per-land watering responses", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-oi-bd-zero-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T01:00:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PALACE_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_SPEEDUP_FREE: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-oi-bd-zero-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-17T01:20:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    const landMap = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [String(1001 + index), { ...seeded }]),
    );
    const sync = {
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 1000000,
          nextExp: 10000000,
          cTime: "2026-06-16T09:00:00.000Z",
          bag: {
            7: 35,
            23001: 16,
          },
          itemExtMap: {
            7: {
              lems: nowMs - 6 * 120000,
              cd: 120000,
              resetNum: 65,
            },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 2,
            cTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap,
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") {
          return raw(sync);
        }
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.water") {
          landMap[args.landId] = { ...growing };
          return raw({
            $usrTot: {
              oi: {
                bd: {
                  7: 0,
                },
              },
            },
            usrLandTot: {
              usrLand: {
                landMap: {
                  [args.landId]: landMap[args.landId],
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(ws, "test-token", sync, 1);

    assert.equal(
      requestLog.filter((entry) => entry.iface === "gs.usrLand.water").length,
      16,
    );
    assert.equal(result.$usrTot.data.bag[ITEM_IDS.WATER_DROP], 25);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterDropText, "25/65");
    assert.equal(statusJson.summary.waterDropWateredCount, 16);
    assert.equal(statusJson.summary.waterDropFlowText, "浇水前 41/65，自然恢复 6；本轮自动浇水消耗 16；结束 25/65");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle waters from client-side restore when a server baseline exists", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-restored-refresh-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T01:10:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-restored-refresh-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-17T01:40:00.000Z", harvestCnt: 0 };
    const growing = { ...seeded, state: 2 };
    let landMap = {
      1001: seeded,
      1002: seeded,
    };
    const makeSync = (bagWater, lems) => ({
      $usrTot: {
        data: {
          cTime: "2026-06-16T09:00:00.000Z",
          bag: {
            7: bagWater,
            23001: 2,
          },
          itemExtMap: {
            7: {
              lems,
              cd: 120000,
              resetNum: 65,
            },
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 2,
            cTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: { ...landMap },
        },
      },
    });
    let currentSync = makeSync(0, nowMs - 16 * 120000);
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw(currentSync);
        if (iface === "gs.usrLand.water") {
          landMap[args.landId] = growing;
          currentSync = makeSync(0, nowMs);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.usrLand.water")
        .map((entry) => entry.args),
      [{ landId: 1001 }, { landId: 1002 }],
    );
    assert.equal(result.$usrTot.data.bag[7], 0);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterDropText, "0/65");
    assert.equal(statusJson.summary.waterDropWateredCount, 2);
    assert.equal(statusJson.waterDecision.waterDropTrust, "authoritative");
    assert.equal(statusJson.waterDecision.serverWaterDropCount, 16);
    assert.equal(statusJson.waterDecision.decisionWaterDropCount, 16);
    assert.equal(statusJson.waterDecision.reason, "seeded-water-enough");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle stops watering and clamps local water drops when server reports water item shortage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-shortage-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T00:50:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-shortage-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-17T01:20:00.000Z", harvestCnt: 0 };
    const sync = {
      $usrTot: {
        data: {
          bag: {
            7: 16,
            23001: 2,
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 2,
            cTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: seeded,
            1002: seeded,
          },
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usrLand.waterBatch") return { m: { code: 500, message: "batch unavailable" } };
        if (iface === "gs.usrLand.water") return { m: { code: 301, param: { iid: 7 } } };
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog.filter((iface) => iface === "gs.usrLand.water"),
      ["gs.usrLand.water"],
    );
    assert.equal(result.$usrTot.data.bag[7], 0);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterDropText, "0/65");
    assert.equal(statusJson.summary.waterDropWateredCount, 0);
    assert.equal(statusJson.summary.waterDropFlowText, "浇水前 16/65，自然恢复 0；本轮自动浇水消耗 0；结束 0/65");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle clamps local water drops when single watering reports shortage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-water-batch-shortage-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-17T00:55:00.000Z");
  Date.now = () => nowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    NO_WATER_FALLBACK: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?water-batch-shortage-cycle-test=${Date.now()}`);
    const seeded = { state: 1, flowerId: 23001, lvl: 2, nextTime: "2026-06-17T01:20:00.000Z", harvestCnt: 0 };
    const sync = {
      $usrTot: {
        data: {
          bag: {
            7: 16,
            23001: 2,
          },
        },
      },
      cultivateTot: {
        cultivateMap: {
          23001: {
            flowerId: 23001,
            lvl: 2,
            cTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
      usrLandTot: {
        usrLand: {
          landMap: {
            1001: seeded,
            1002: seeded,
          },
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usrLand.water") return { m: { code: 301, param: { iid: 7 } } };
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog.filter((iface) => iface === "gs.usrLand.water"),
      ["gs.usrLand.water"],
    );
    assert.equal(result.$usrTot.data.bag[7], 0);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.waterDropText, "0/65");
    assert.equal(statusJson.summary.waterDropWateredCount, 0);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle writes compact loop logs while keeping full status documents", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-compact-log-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logLines = [];
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    SUMMARY_ONLY: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
  });
  console.log = (line = "") => {
    logLines.push(String(line));
  };

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?compact-log-cycle-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    Object.assign(sync.$usrTot.data.bag, {
      [ITEM_IDS.PEARL]: 12,
      [ITEM_IDS.FLOWER_SHOP_COIN]: 34,
      [ITEM_IDS.SATIN_SILK]: 45,
      [ITEM_IDS.BUILDING_MATERIAL]: 67,
      [ITEM_IDS.YUANBAO]: 1,
      [ITEM_IDS.GOLD]: 2,
      300101: 2,
      300102: 5,
    });
    sync.$usrTot.data.dmd = 56;
    sync.$usrTot.data.gld = 7890;
    const ws = {
      async request(iface) {
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    const cycleSummary = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.step === "cycleSummary");
    assert.ok(cycleSummary);
    assert.equal(cycleSummary.waterDropText, "99/65");
    assert.equal(cycleSummary.land.emptyCount, 0);
    assert.equal(Object.hasOwn(cycleSummary, "resources"), false);
    assert.equal(Object.hasOwn(cycleSummary.recommendation, "candidateTop5"), false);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.ok(statusJson.resources.waterDrop);
    assert.match(statusJson.customerOrders.autoSubmitRule, /account-scoped exact release list/);
    assert.match(statusJson.customerOrders.autoSubmitRule, /gs\.orderCustomer\.rejectOrder/);
    assert.equal(statusJson.resources.items.pearl.count, 12);
    assert.equal(statusJson.resources.items.pearl.sourcePath, "$usrTot.data.bag[1006]");
    assert.equal(statusJson.resources.items.flowerShopCoin.count, 34);
    assert.equal(statusJson.resources.items.flowerShopCoin.sourcePath, "$usrTot.data.bag[1002]");
    assert.equal(statusJson.resources.items.satinSilk.count, 45);
    assert.equal(statusJson.resources.items.satinSilk.sourcePath, "$usrTot.data.bag[1106]");
    assert.equal(statusJson.resources.items.buildingMaterial.count, 67);
    assert.equal(statusJson.resources.items.buildingMaterial.sourcePath, "$usrTot.data.bag[1340]");
    assert.equal(statusJson.resources.items.yuanbao.sourcePath, "$usrTot.data.dmd");
    assert.equal(statusJson.resources.items.gold.sourcePath, "$usrTot.data.gld");
    assert.equal(statusJson.summary.pearlCount, 12);
    assert.equal(statusJson.summary.flowerShopCoinCount, 34);
    assert.equal(statusJson.summary.satinSilkCount, 45);
    assert.equal(statusJson.summary.buildingMaterialCount, 67);
    assert.equal(statusJson.summary.yuanbaoCount, 56);
    assert.equal(statusJson.summary.goldCount, 7890);
    assert.deepEqual(statusJson.flowerArtInventory.rows.slice(0, 2).map((row) => row.artId), [300102, 300101]);
    assert.match(statusJson.flowerArtInventory.rows[0].artName, /^百合瓷韵：/);
    assert.match(statusJson.flowerArtInventory.rows[0].artName, /白百合/);
    assert.equal(statusJson.flowerArtInventory.rows[0].artCount, 5);
    assert.equal(statusJson.flowerArtInventory.rows[0].salePrice, 143);
    assert.match(statusJson.flowerArtInventory.rows[0].vaseText, /3001/);
    assert.match(statusJson.flowerArtInventory.rows[0].flowersText, /白百合/);
    const statusMd = fs.readFileSync(path.join(outDir, "garden-status.md"), "utf8");
    assert.match(statusMd, /珍珠/);
    assert.match(statusMd, /花坊币/);
    assert.match(statusMd, /丝绸\/绸缎/);
    assert.match(statusMd, /建材/);
    assert.match(statusMd, /花艺库存/);
    assert.match(statusMd, /百合瓷韵/);
    assert.match(statusMd, /未在放行列表的已知收益订单标记为暂时没货并按官方按钮拒绝/);
    assert.doesNotMatch(statusMd, /保持待处理，不制作、不提交、不拒绝/);
    const statusHtml = fs.readFileSync(path.join(outDir, "garden-status.html"), "utf8");
    assert.match(statusHtml, /未在放行列表的已知收益订单标记为暂时没货并按官方按钮拒绝/);
    assert.doesNotMatch(statusHtml, /保持待处理，不制作、不提交、不拒绝/);
    assert.doesNotMatch(statusHtml, /\.section\s*\{[^}]*max-height/i);
    assert.doesNotMatch(statusHtml, /\.section\s*\{[^}]*overflow:\s*auto/i);
    const cultivatedIndex = statusHtml.indexOf("花朵库存明细");
    const landIndex = statusHtml.indexOf("土地种植明细");
    const flowerArtIndex = statusHtml.indexOf("花艺库存");
    const customerIndex = statusHtml.indexOf("顾客订单状态");
    const runHistoryIndex = statusHtml.indexOf("本次启动记录（顾客检查");
    assert.ok(cultivatedIndex >= 0, "garden-status.html should include flower inventory details");
    assert.ok(landIndex > cultivatedIndex, "land planting details should follow flower inventory details");
    assert.ok(flowerArtIndex > landIndex, "flower art inventory should follow land planting details");
    assert.ok(customerIndex > flowerArtIndex, "customer order status should follow flower art inventory");
    assert.ok(runHistoryIndex > customerIndex, "startup customer run history should follow customer order status");
    assert.ok(Array.isArray(statusJson.plantCandidatesSorted));
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle shows owned and acquired but uncultivated flowers in status inventory", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-flower-inventory-source-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?flower-inventory-source-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    Object.assign(sync.$usrTot.data.bag, {
      23001: 20,
      23087: 7,
      23280: 1,
      23088: 2,
      1403: 5,
    });
    sync.cultivateTot.cultivateMap = {
      23001: { flowerId: 23001, lvl: 2, cTime: "2026-06-16T00:00:00.000Z" },
      23088: { flowerId: 23088, lvl: 1, cTime: "2026-06-17T00:00:00.000Z" },
    };
    const ws = {
      async request(iface) {
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    const rowsById = new Map(statusJson.inventorySorted.map((row) => [row.flowerId, row]));
    assert.equal(statusJson.inventoryScope, "owned/acquired flower inventory plus cultivated and planted flowers");
    assert.deepEqual(statusJson.inventorySorted.map((row) => row.flowerId), [23001, 23280, 23088, 23087]);
    assert.deepEqual(statusJson.uncultivatedInventorySorted.map((row) => row.flowerId), [23088, 23280, 23087]);
    assert.equal(rowsById.get(23001).cultivated, true);
    assert.equal(rowsById.get(23001).cultivatedText, "是");
    assert.equal(rowsById.get(23087).count, 7);
    assert.equal(rowsById.get(23087).cultivated, false);
    assert.equal(rowsById.get(23087).cultivatedText, "否");
    assert.match(rowsById.get(23087).acquisitionText, /花坊兑换/);
    assert.equal(rowsById.get(23280).cultivated, false);
    assert.match(rowsById.get(23280).acquisitionText, /首充壕礼/);
    assert.equal(rowsById.get(23088).cultivated, false);
    assert.equal(rowsById.get(23088).cultivatedText, "否（等级1）");
    assert.match(rowsById.get(23088).acquisitionText, /累计充值/);
    assert.match(rowsById.get(23087).missingCultivationCostText, /除螨液 \(1403\) x15/);
    assert.notEqual(rowsById.get(23087).missingCultivationCostText, rowsById.get(23087).cultivationCostText);

    const statusMd = fs.readFileSync(path.join(outDir, "garden-status.md"), "utf8");
    const statusHtml = fs.readFileSync(path.join(outDir, "garden-status.html"), "utf8");
    assert.match(statusMd, /## 已培育花库存/);
    assert.match(statusMd, /## 未培育花库存/);
    assert.doesNotMatch(statusMd, /\| 花名 \| flowerId \| 库存 \| 培育等级 \| 是否已培育 \|/);
    assert.match(statusMd, /\| 花名 \| flowerId \| 库存 \| 培育等级 \| 获取途径 \| 收获间隔时间 \| 当前种植数 \| 培育时间 \|/);
    assert.match(statusMd, /\| 花名 \| flowerId \| 库存 \| 培育等级 \| 获取途径 \| 收获间隔时间 \| 培育时间 \| 培育所需材料 \| 缺少的材料清单 \|/);
    assert.doesNotMatch(statusMd, /\| 花名 \| flowerId \| 库存 \| 培育等级 \| 获取途径 \| 收获间隔时间 \| 基础时间 \| 进阶扣减 \|/);
    assert.match(statusMd, /获取途径/);
    assert.match(statusMd, /培育所需材料/);
    assert.match(statusMd, /缺少的材料清单/);
    assert.match(statusMd, /花坊兑换/);
    assert.match(statusMd, /除螨液.*1403.*20/);
    assert.match(statusMd, /除螨液.*1403.*15/);
    assert.match(statusHtml, /已培育花库存/);
    assert.match(statusHtml, /未培育花库存/);
    assert.doesNotMatch(statusHtml, /<th>是否已培育<\/th>/);
    assert.doesNotMatch(statusHtml, /<th>基础时间<\/th>/);
    assert.doesNotMatch(statusHtml, /<th>进阶扣减<\/th>/);
    assert.match(statusHtml, /<th>培育所需材料<\/th>/);
    assert.match(statusHtml, /<th>缺少的材料清单<\/th>/);
    assert.match(statusHtml, /获取途径/);
    assert.match(statusHtml, /首充壕礼/);
    assert.match(statusHtml, /除螨液 \(1403\) x15/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick syncs fresh status documents every five seconds without running cycle actions", async () => {
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logLines = [];
  assignCycleEnv({
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "1",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "1",
    AUTO_HANDLE_PEARL: "1",
    AUTO_HANDLE_FML_LAND: "1",
  });
  console.log = (line = "") => {
    logLines.push(String(line));
  };

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?status-refresh-wait-test=${Date.now()}`);
    const startMs = Date.parse("2026-06-17T07:00:00.000Z");
    let nowMs = startMs;
    const requestLog = [];
    const statusWrites = [];
    const sync = makeSync({}, 0);
    const refreshedWaterDrops = [101, 102, 103];
    const refreshedFmlMatureCounts = [1, 2, 3];
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: refreshedWaterDrops.shift(),
                },
              },
            },
          });
        }
        if (iface === "gs.usrLand.refresh") return raw({});
        if (iface === "gs.fml.enter") {
          return raw({
            fmlTot: {
              fmlLand: {
                landMap: {
                  601: {
                    flwId: 23001,
                    lvl: 2,
                    matureFlwCnt: refreshedFmlMatureCounts.shift(),
                  },
                },
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await waitWithOnlineHeartTick(ws, "test-token", sync, 16_000, {
      cycle: 7,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      authoritativeSnapshotIntervalMs: 5_000,
      statusWriter: (syncValue, context) => {
        statusWrites.push({
          atMs: nowMs,
          step: context.step,
          cycle: context.cycle,
          log: context.log,
          statusMode: context.statusMode,
          waterDrop: syncValue.$usrTot.data.bag[ITEM_IDS.WATER_DROP],
          fmlMatureCount: syncValue.fmlTot?.fmlLand?.landMap?.[601]?.matureFlwCnt,
        });
      },
    });

    assert.deepEqual(requestLog.filter((iface) => iface !== "gs.usr.lazySync"), [
      "gs.usr.heartTick",
      "gs.usrLand.refresh",
      "gs.fml.enter",
      "gs.usrLand.refresh",
      "gs.fml.enter",
      "gs.usrLand.refresh",
      "gs.fml.enter",
    ]);
    assert.deepEqual(statusWrites.map((item) => item.atMs - startMs), [5000, 10000, 15000]);
    assert.deepEqual(statusWrites.map((item) => item.waterDrop), [101, 102, 103]);
    assert.deepEqual(statusWrites.map((item) => item.fmlMatureCount), [1, 2, 3]);
    assert.deepEqual(statusWrites.map((item) => item.step), [
      "loopStatusRefresh",
      "loopStatusRefresh",
      "loopStatusRefresh",
    ]);
    assert.deepEqual(statusWrites.map((item) => item.cycle), [7, 7, 7]);
    assert.deepEqual(statusWrites.map((item) => item.log), [false, false, false]);
    assert.deepEqual(statusWrites.map((item) => item.statusMode), [
      "loop-refresh",
      "loop-refresh",
      "loop-refresh",
    ]);

    const fmlLogs = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.step === "fmlLandStatusRefresh");
    assert.equal(fmlLogs.length, 3);
    assert.deepEqual(fmlLogs.map((entry) => entry.rows[0].matureFlwCnt), [1, 2, 3]);
    assert.deepEqual(fmlLogs[0].rows[0], {
      landId: 601,
      flowerId: 23001,
      lvl: 2,
      matureFlwCnt: 1,
      estimatedMatureFlwCnt: 0,
      displayMatureFlwCnt: 1,
      stock: 10,
      canHarvest: true,
      matureSource: "server-matureFlwCnt",
      statusText: "可收获",
    });
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
  }
});

test("waitWithOnlineHeartTick writes loop refresh snapshots without overwriting last action flow", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-loop-refresh-status-mode-"));
  const settingsPath = path.join(outDir, "settings.json");
  const oldEnv = { ...process.env };
  const startMs = Date.parse("2026-06-17T07:00:00.000Z");
  let nowMs = startMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    STATUS_REFRESH_INTERVAL_SECONDS: "5",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      autoReceiveWaterwheelBuckets: true,
      skipWaterwheelVideoBuckets: true,
    }), "utf8");
    fs.writeFileSync(path.join(outDir, "garden-status.json"), `${JSON.stringify({
      statusMode: "cycle-action",
      resources: {
        waterDropFlow: {
          mode: "cycle-action",
          flowText: "ACTION FLOW 84 to 40",
        },
      },
    }, null, 2)}\n`, "utf8");

    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?status-refresh-mode-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 84;
    sync.waterwheel = { count: 2, advList: [3] };
    const ws = {
      async request(iface) {
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                bag: {
                  [ITEM_IDS.WATER_DROP]: 2,
                },
              },
            },
          });
        }
        if (iface === "gs.usrLand.refresh") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await waitWithOnlineHeartTick(ws, "test-token", sync, 6_000, {
      cycle: 7,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      authoritativeSnapshotIntervalMs: 5_000,
    });

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.statusMode, "loop-refresh");
    assert.equal(statusJson.resources.waterDropFlow.mode, "loop-refresh-snapshot");
    assert.doesNotMatch(statusJson.resources.waterDropFlow.flowText, /本轮|鏈疆/);
    assert.equal(statusJson.lastActionWaterDropFlow.flowText, "ACTION FLOW 84 to 40");
    assert.equal(statusJson.summary.lastActionWaterDropFlowText, "ACTION FLOW 84 to 40");
    assert.equal(statusJson.summary.waterDropText, "2/65");
    assert.equal(statusJson.summary.waterwheelActionCount, 0);
    assert.equal(statusJson.summary.waterwheelReceivedCount, 0);
    assert.equal(statusJson.summary.waterwheelNormalReceivedCount, 0);
    assert.equal(statusJson.summary.waterwheelVideoBaseReceivedCount, 0);
    assert.equal(statusJson.waterwheel.configuredAutoReceiveEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveAutoReceiveEnabled, false);
    assert.equal(statusJson.waterwheel.configuredSkipVideoBucketsEnabled, true);
    assert.equal(statusJson.waterwheel.effectiveSkipVideoBucketsEnabled, false);
    assert.deepEqual(statusJson.waterwheel.pendingWaterwheelActions, []);
    assert.equal(statusJson.waterwheel.waterDropText, "2/65");
    assert.equal(statusJson.waterwheel.remainingBucketCount, 58);
    assert.equal(statusJson.waterwheel.nextBucketNo, 3);
    assert.equal(statusJson.waterwheel.nextBucketIsVideo, true);
    const waterwheelQueueRow = statusJson.automationQueue.rows.find((row) => row.area === "水车水桶");
    assert.equal(waterwheelQueueRow?.pending, 0);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick logs waterwheel status refresh with plant refill threshold", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "status-waterwheel-threshold-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logLines = [];
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_WATERWHEEL: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });
  console.log = (line = "") => {
    logLines.push(String(line));
  };

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?status-waterwheel-threshold-test=${Date.now()}`);
    const startMs = Date.parse("2026-06-17T07:00:00.000Z");
    let nowMs = startMs;
    const requestLog = [];
    const sync = makeSync(Object.fromEntries(makeLandEntries(1001, 16, {})), 100);
    sync.$usrTot.data.bag[ITEM_IDS.WATER_DROP] = 10;
    sync.waterwheel = { count: 40, advList: [41] };
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.refresh") return raw({});
        if (iface === "gs.waterwheel.enter") return raw({ waterwheel: { count: 40, advList: [41] } });
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await waitWithOnlineHeartTick(ws, "test-token", sync, 6_000, {
      cycle: 7,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      authoritativeSnapshotIntervalMs: 5_000,
      statusWriter: () => {},
    });

    assert.deepEqual(requestLog.filter((iface) => iface !== "gs.usr.lazySync"), [
      "gs.usr.heartTick",
      "gs.usrLand.refresh",
      "gs.waterwheel.enter",
    ]);

    const waterwheelLog = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.step === "waterwheelStatusRefresh");
    assert.equal(waterwheelLog.threshold, 16);
    assert.equal(waterwheelLog.reason, "next-bucket-video-retained");
    assert.match(waterwheelLog.reasonText, /视频桶/);
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick handles near-mature flowers during status refresh", async () => {
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logLines = [];
  assignCycleEnv({
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    AUTO_SPEEDUP_FREE: "1",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });
  console.log = (line = "") => {
    logLines.push(String(line));
  };

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?status-growth-test=${Date.now()}`);
    const startMs = Date.parse("2026-06-17T07:00:00.000Z");
    let nowMs = startMs;
    Date.now = () => nowMs;
    const nearMature = {
      state: 2,
      flowerId: 23001,
      lvl: 2,
      nextTime: new Date(startMs + 58_000).toISOString(),
      harvestCnt: 0,
    };
    let currentSync = makeSync({ 1001: nearMature }, 0);
    const requestLog = [];
    const statusWrites = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args, atMs: nowMs });
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usrLand.speedUpFree") {
          currentSync = makeSync({ 1001: { ...nearMature, state: 3, nextTime: new Date(nowMs).toISOString() } }, 0);
          return raw(currentSync);
        }
        if (iface === "gs.usrLand.harvest") {
          currentSync = makeSync({ 1001: {} }, 1);
          return raw(currentSync);
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await waitWithOnlineHeartTick(ws, "test-token", currentSync, 6_000, {
      cycle: 9,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      authoritativeSnapshotIntervalMs: 5_000,
      statusWriter: (syncValue, context) => {
        statusWrites.push({
          atMs: nowMs,
          step: context.step,
          land: syncValue.usrLandTot.usrLand.landMap[1001],
        });
      },
    });

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface !== "gs.usr.lazySync")
        .map((item) => [item.iface, item.atMs - startMs]),
      [
        ["gs.usr.heartTick", 0],
        ["gs.usrLand.refresh", 5000],
        ["gs.usrLand.speedUpFree", 5000],
        ["gs.usrLand.refresh", 5000],
        ["gs.usrLand.harvest", 5000],
        ["gs.usrLand.refresh", 5000],
      ],
    );
    assert.deepEqual(result.usrLandTot.usrLand.landMap[1001], {});
    assert.equal(result.$usrTot.data.bag[23001], 1);
    assert.deepEqual(statusWrites.map((item) => item.step), ["loopStatusRefresh"]);
    assert.deepEqual(statusWrites[0].land, {});

    const growthLog = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.step === "loopTimeCriticalGrowth");
    assert.equal(growthLog.speedUpFree, true);
    assert.equal(growthLog.harvestedCount, 1);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
  }
});

test("waitWithOnlineHeartTick stops a partial mature harvest at the experience boundary", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-wait-experience-guard-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify({ experienceGuardThresholdPercent: 0.5 })}\n`, "utf8");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logs = [];
  const startMs = Date.parse("2026-06-17T07:00:00.000Z");
  let nowMs = startMs;
  Date.now = () => nowMs;
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    PROFILE_SETTINGS_PATH: settingsPath,
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    STATUS_REFRESH_INTERVAL_SECONDS: "5",
    ASSET_SYNC_INTERVAL_SECONDS: "0",
    AUTO_SPEEDUP_FREE: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { waitWithOnlineHeartTick } = await import(
      `./inspect-garden-dryrun.mjs?wait-experience-guard-test=${Date.now()}`
    );
    const matureLand = {
      flowerId: 23001,
      state: 3,
      harvestCnt: 1,
      nextTime: new Date(startMs).toISOString(),
    };
    let currentSync = makeSync({
      1001: { landId: 1001, ...matureLand },
      1002: { landId: 1002, ...matureLand },
    }, 0);
    currentSync.$usrTot.data.lvlExp = 9_949_989;
    currentSync.$usrTot.data.nextExp = 10_000_000;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") {
          return raw({
            $usrTot: {
              data: {
                lvl: 40,
                lvlExp: currentSync.$usrTot.data.lvlExp,
                nextExp: 10_000_000,
              },
            },
          });
        }
        if (iface === "gs.usrLand.harvest") {
          const nextExp = currentSync.$usrTot.data.lvlExp + 10;
          const nextLandMap = {
            ...currentSync.usrLandTot.usrLand.landMap,
            [args.landId]: {},
          };
          currentSync = {
            ...currentSync,
            $usrTot: {
              ...currentSync.$usrTot,
              data: {
                ...currentSync.$usrTot.data,
                lvlExp: nextExp,
              },
            },
            usrLandTot: {
              usrLand: {
                landMap: nextLandMap,
              },
            },
          };
          return raw({
            $usrTot: {
              data: {
                lvl: 40,
                lvlExp: nextExp,
                nextExp: 10_000_000,
              },
              oi: {
                bi: {
                  [ITEM_IDS.EXPERIENCE]: 10,
                },
              },
            },
            usrLandTot: currentSync.usrLandTot,
          });
        }
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await waitWithOnlineHeartTick(ws, "test-token", currentSync, 6_000, {
      cycle: 13,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      authoritativeSnapshotIntervalMs: 5_000,
      statusRefresher: async (_ws, _token, next) => next,
      statusWriter: () => {},
    });

    const harvestRequests = requestLog.filter((entry) => entry.iface === "gs.usrLand.harvest");
    assert.deepEqual(harvestRequests.map((entry) => entry.args.landId), [1001]);
    assert.equal(result.$usrTot.data.lvlExp, 9_949_999);
    assert.deepEqual(result.usrLandTot.usrLand.landMap[1001], {});
    assert.equal(result.usrLandTot.usrLand.landMap[1002].state, 3);
    const skip = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((entry) => entry?.step === "experienceGuardActionSkip");
    assert.equal(skip?.iface, "gs.usrLand.harvest");
    assert.equal(skip?.reason, "experience-protection-boundary");
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("waitWithOnlineHeartTick generates customer orders during wait when next generation time expires", async () => {
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logLines = [];
  assignCycleEnv({
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "1",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "0",
  });
  console.log = (line = "") => {
    logLines.push(String(line));
  };

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?customer-wait-gen-test=${Date.now()}`);
    const startMs = Date.parse("2026-06-17T07:00:00.000Z");
    let nowMs = startMs;
    Date.now = () => nowMs;
    const requestLog = [];
    const statusWrites = [];
    const baseSync = makeSync({}, 0);
    const sync = {
      ...baseSync,
      $usrTot: {
        ...baseSync.$usrTot,
        cntMap: {
          107: { type: 107, tdyCnt: 0 },
        },
      },
      $timeAuthority: {
        version: 1,
        lastAcceptedSample: {
          serverMs: startMs,
          correctedServerMs: startMs,
          requestStartedAtMs: startMs,
          responseAtMs: startMs,
          rttMs: 0,
          serverOffsetMs: 0,
          acceptedAtMs: startMs,
        },
        sampleMaxAgeMs: 120_000,
      },
      orderCustomerTot: {
        orderCustomer: {
          nextGenTime: new Date(startMs + 3_000).toISOString(),
          orderMap: {},
        },
      },
    };
    const generatedOrderSync = {
      orderCustomerTot: {
        orderCustomer: {
          nextGenTime: new Date(startMs + 5 * 60_000).toISOString(),
          orderMap: {
            1: {
              artId: 300001,
              num: 1,
              cTime: "2026-06-17T07:00:05.000Z",
            },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args, atMs: nowMs });
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await waitWithOnlineHeartTick(ws, "test-token", sync, 16_000, {
      cycle: 8,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      statusRefreshIntervalMs: 5_000,
      statusRefresher: async (_ws, _gsToken, syncValue) => syncValue,
      orderCustomerNpcConfig: customerNpcConfigForTest([1, 4, 8], "fixture:customer-wait-test"),
      flowerArtConfig: { sourcePath: "customer-wait-test", customerMax: 3 },
      statusWriter: (syncValue, context) => {
        statusWrites.push({
          atMs: nowMs,
          step: context.step,
          orderCount: Object.keys(syncValue.orderCustomerTot?.orderCustomer?.orderMap || {}).length,
        });
      },
    });

    assert.deepEqual(
      requestLog
        .filter((item) => item.iface !== "gs.usr.lazySync")
        .map((item) => [item.iface, item.atMs - startMs]),
      [
        ["gs.usr.heartTick", 0],
        ["gs.orderCustomer.genOrder", 4001],
      ],
    );
    assert.deepEqual(requestLog.find((item) => item.iface === "gs.orderCustomer.genOrder").args, { guestNpcIdList: [] });
    assert.deepEqual(statusWrites.map((item) => item.orderCount), [1, 1, 1, 1]);
    assert.equal(Object.keys(result.orderCustomerTot.orderCustomer.orderMap).length, 1);

    const customerLogs = logLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.step === "customerOrderGenDuringWait");
    assert.equal(customerLogs.length, 1);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
  }
});

test("waitWithOnlineHeartTick returns immediately after generated customer orders are processed", async () => {
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logLines = [];
  assignCycleEnv({
    ONLINE_HEART_TICK_INTERVAL_SECONDS: "60",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "1",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "0",
  });
  console.log = (line = "") => {
    logLines.push(String(line));
  };

  try {
    const { waitWithOnlineHeartTick } = await import(`./inspect-garden-dryrun.mjs?customer-wait-gen-early-return-test=${Date.now()}`);
    const startMs = Date.parse("2026-06-17T07:00:00.000Z");
    let nowMs = startMs;
    Date.now = () => nowMs;
    const requestLog = [];
    const statusWrites = [];
    const processorCalls = [];
    const baseSync = makeSync({}, 0);
    const sync = {
      ...baseSync,
      $usrTot: {
        ...baseSync.$usrTot,
        cntMap: {
          107: { type: 107, tdyCnt: 0 },
        },
      },
      $timeAuthority: makeTrustedTimeAuthority(startMs),
      orderCustomerTot: {
        orderCustomer: {
          nextGenTime: new Date(startMs + 3_000).toISOString(),
          orderMap: {},
        },
      },
    };
    const generatedOrderSync = {
      orderCustomerTot: {
        orderCustomer: {
          nextGenTime: new Date(startMs + 5 * 60_000).toISOString(),
          orderMap: {
            1: {
              artId: 300001,
              num: 1,
              cTime: "2026-06-17T07:00:05.000Z",
            },
          },
        },
      },
    };
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args, atMs: nowMs });
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderCustomer.genOrder") return raw(generatedOrderSync);
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await waitWithOnlineHeartTick(ws, "test-token", sync, 16_000, {
      cycle: 9,
      nowFn: () => nowMs,
      waitFn: async (ms) => {
        nowMs += ms;
      },
      statusRefreshIntervalMs: 5_000,
      statusRefresher: async (_ws, _gsToken, syncValue) => syncValue,
      orderCustomerNpcConfig: customerNpcConfigForTest([1, 4, 8], "fixture:customer-wait-test"),
      flowerArtConfig: { sourcePath: "customer-wait-test", customerMax: 3 },
      growthHandler: async (_ws, _gsToken, syncValue) => ({ syncValue }),
      statusWriter: (syncValue, context) => {
        statusWrites.push({
          atMs: nowMs,
          step: context.step,
          orderCount: Object.keys(syncValue.orderCustomerTot?.orderCustomer?.orderMap || {}).length,
        });
      },
      customerOrderProcessor: async (_ws, _gsToken, syncValue) => {
        processorCalls.push(nowMs);
        return {
          syncValue: {
            ...syncValue,
            customerOrderProcessedAtMs: nowMs,
          },
          actionCount: 1,
        };
      },
    });

    assert.equal(nowMs - startMs, 4_001);
    assert.deepEqual(processorCalls, [startMs + 4_001]);
    assert.equal(result.customerOrderProcessedAtMs, startMs + 4_001);
    assert.deepEqual(statusWrites, []);
    assert.deepEqual(
      requestLog.map((item) => [item.iface, item.atMs - startMs]),
      [
        ["gs.usr.heartTick", 0],
        ["gs.orderCustomer.genOrder", 4_001],
      ],
    );
    assert.equal(logLines.some((line) => line.includes('"step":"customerOrderGenerationToAction"')), true);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
  }
});

test("runGardenCycle buys every visible material shop item when current gold covers the full cost", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-material-shop-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_MATERIAL_SHOP: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?material-shop-cycle-test=${Date.now()}`);
    const sync = makeSync({
      1001: {
        state: 2,
        flowerId: 23001,
        lvl: 2,
        nextTime: "2099-01-01T00:00:00.000Z",
      },
    }, 0);
    sync.$usrTot.data.gld = 7400;

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.shopCultivate.enter") {
          return raw({
            shopCultivate: {
              infoMap: {
                10001: [11, 3200],
                10002: [11, 4200],
              },
              bRecord: {},
              larTime: "2026-06-17T00:00:00.000Z",
            },
          });
        }
        if (iface === "gs.shopCultivate.buy" && args.shopId === 10001) {
          return raw({
            $usrTot: {
              data: {
                gld: 4200,
                bag: { 1401: 1 },
              },
            },
            shopCultivate: {
              bRecord: { 10001: 1 },
            },
          });
        }
        if (iface === "gs.shopCultivate.buy" && args.shopId === 10002) {
          return raw({
            $usrTot: {
              data: {
                gld: 0,
                bag: { 1402: 1 },
              },
            },
            shopCultivate: {
              bRecord: { 10001: 1, 10002: 1 },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.shopCultivate"))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.shopCultivate.enter", {}],
        ["gs.shopCultivate.buy", { shopId: 10001 }],
        ["gs.shopCultivate.buy", { shopId: 10002 }],
      ],
    );

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.materialShopBoughtCount, 2);
    assert.equal(statusJson.summary.materialShopSpentGold, 7400);
    assert.equal(statusJson.materialShop.rows[0].statusText, "已售罄");
    assert.equal(statusJson.materialShop.rows[1].statusText, "已售罄");
    assert.equal(statusJson.resources.items.gold.count, 0);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits palace order during double gold when flower stock is enough", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-palace-order-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?palace-order-cycle-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    sync.$usrTot.data.bag[23002] = 45;
    sync.videoDouble = {
      eTime: "2099-01-01T00:00:00.000Z",
    };
    sync.fashionTot = {
      fashionUnitMap: {},
    };
    sync.orderPalaceTot = {
      orderPalace: {
        flowerId: 23002,
        num: 40,
        isFinish: false,
        cTime: "2026-06-16T01:50:00.000Z",
      },
    };

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderPalace.enter") return raw(sync);
        if (iface === "gs.orderPalace.finishOrder") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.orderPalace"))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.orderPalace.enter", {}],
        ["gs.orderPalace.finishOrder", {}],
      ],
    );
    assert.equal(result.orderPalaceTot.orderPalace.isFinish, true);
    assert.equal(result.$usrTot.data.bag[23002], 5);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.palaceOrderSubmittedCount, 1);
    assert.equal(statusJson.palaceOrders.status, "completed");
    assert.equal(statusJson.palaceOrders.have, 5);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle clears local palace flower stock when palace submit reports item shortage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-palace-order-shortage-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_MATERIAL_SHOP: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?palace-order-shortage-cycle-test=${Date.now()}`);
    const sync = makeSync({
      1001: {
        state: 2,
        flowerId: 23001,
        lvl: 2,
        nextTime: "2099-01-01T00:00:00.000Z",
      },
    }, 0);
    sync.$usrTot.data.bag[23002] = 45;
    sync.$usrTot.data.gld = 3200;
    sync.videoDouble = {
      eTime: "2099-01-01T00:00:00.000Z",
    };
    sync.fashionTot = {
      fashionUnitMap: {},
    };
    sync.orderPalaceTot = {
      orderPalace: {
        flowerId: 23002,
        num: 40,
        isFinish: false,
        cTime: "2026-06-16T01:50:00.000Z",
      },
    };

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderPalace.enter") return raw(sync);
        if (iface === "gs.orderPalace.finishOrder") {
          return {
            m: {
              code: 301,
              param: { iid: 23002 },
            },
          };
        }
        if (iface === "gs.shopCultivate.enter") {
          return raw({
            shopCultivate: {
              infoMap: {
                10001: [11, 3200],
              },
              bRecord: {},
              larTime: "2026-06-17T00:00:00.000Z",
            },
          });
        }
        if (iface === "gs.shopCultivate.buy" && args.shopId === 10001) {
          return raw({
            $usrTot: {
              data: {
                gld: 0,
                bag: { 1401: 1 },
              },
            },
            shopCultivate: {
              bRecord: { 10001: 1 },
            },
          });
        }
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.orderPalace"))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.orderPalace.enter", {}],
        ["gs.orderPalace.finishOrder", {}],
      ],
    );
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.shopCultivate"))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.shopCultivate.enter", {}],
        ["gs.shopCultivate.buy", { shopId: 10001 }],
      ],
    );
    assert.equal(result.orderPalaceTot.orderPalace.isFinish, false);
    assert.equal(result.$usrTot.data.bag[23002], 0);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.palaceOrderSubmittedCount, 0);
    assert.equal(statusJson.summary.materialShopBoughtCount, 1);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps next main task visible after submit and sparse lazy sync", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-main-task-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "1",
    MAIN_TASK_MAX_SUBMIT_PER_CYCLE: "1",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?main-task-cycle-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    sync.taskTot = {
      main: {
        curTaskId: 10001,
        curValue: 4,
        recvMap: {},
      },
    };

    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.taskMain.recv") {
          return raw({
            taskTot: {
              main: {
                curTaskId: 20001,
                curValue: 0,
                recvMap: { 10001: 1 },
              },
            },
          });
        }
        if (iface === "gs.usr.lazySync") {
          return raw({
            taskTot: {
              dly: {
                score: 10,
              },
            },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.taskMain"))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.taskMain.recv", {}],
      ],
    );
    assert.equal(result.taskTot.main.curTaskId, 20001);
    assert.equal(result.taskTot.dly.score, 10);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.mainTaskSubmittedCount, 1);
    assert.equal(statusJson.mainTasks.taskId, 20001);
    assert.match(statusJson.mainTasks.detailText, /^当前任务详情：任务 20001，/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle renders main task status details when current task id is missing", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-main-task-missing-id-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?main-task-missing-id-test=${Date.now()}`);
    const sync = makeSync({}, 0);
    sync.taskTot = {
      main: {
        curValue: 64,
        recvMap: {},
      },
    };

    const ws = {
      async request(iface) {
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.mainTasks.status, "no-current-task");
    assert.equal(statusJson.mainTasks.curValue, 64);
    assert.match(statusJson.mainTasks.detailText, /当前任务详情：暂无当前主线任务/);

    const statusHtml = fs.readFileSync(path.join(outDir, "garden-status.html"), "utf8");
    assert.match(statusHtml, /主线任务状态/);
    assert.match(statusHtml, /暂无当前主线任务/);
    assert.match(statusHtml, /taskTot\.main/);
    assert.match(statusHtml, />64</);
    assert.doesNotMatch(statusHtml, /暂无主线任务状态/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits ordinary resident orders beyond resident main task remaining progress", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-resident-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T02:00:00.000Z");
  Date.now = () => nowMs;
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitOrdinaryResidentOrdersForLevelUp: true,
    experienceGuardThresholdPercent: 0,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    EXPERIENCE_GUARD_STATE_PATH: path.join(outDir, "experience-guard.json"),
    AUTO_HANDLE_TEAM_ORDERS: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-resident-cycle-test=${Date.now()}`);
    const task = getResidentOrderMainTaskForTest();
    const taskId = Number(task.id);
    const targetValue = Number(task.value);
    let currentSync = {
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          bag: {
            7: 99,
            23001: 99,
          },
        },
        cntMap: {
          109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: {
        main: {
          curTaskId: taskId,
          curValue: targetValue - 2,
          recvMap: {},
        },
      },
      orderTeamTot: {
        orderTeam: { status: 0 },
      },
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            301: { boxId: 301, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
            302: { boxId: 302, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
            303: { boxId: 303, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
    };
    const requestLog = [];
    let checkpointCount = 0;
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({ taskTot: currentSync.taskTot });
        if (iface === "gs.orderFlower.enter") return raw(currentSync);
        if (iface === "gs.orderFlower.finishOrder") {
          delete currentSync.orderFlowerTot.orderFlower.orderMap[args.boxId];
          currentSync.taskTot.main.curValue += 1;
          currentSync = {
            ...currentSync,
            orderTeamTot: {
              orderTeam: {
                status: 2,
                startTime: nowMs,
                orderNum: 1,
                flowerId: 23001,
              },
            },
          };
          return raw({
            taskTot: currentSync.taskTot,
            orderFlowerTot: currentSync.orderFlowerTot,
            orderTeamTot: currentSync.orderTeamTot,
          });
        }
        if (iface === "gs.orderTeam.submitOrder") {
          checkpointCount += 1;
          currentSync = {
            ...currentSync,
            checkpointMarker: checkpointCount,
            orderTeamTot: { orderTeam: { status: 0 } },
          };
          return raw({
            checkpointMarker: checkpointCount,
            orderTeamTot: currentSync.orderTeamTot,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.orderFlower.finishOrder")
        .map((entry) => entry.args),
      [
        { boxId: 301 },
        { boxId: 302 },
        { boxId: 303 },
      ],
    );
    assert.equal(currentSync.taskTot.main.curValue, targetValue + 1);
    assert.equal(Object.hasOwn(currentSync.orderFlowerTot.orderFlower.orderMap, 303), false);
    assert.deepEqual(
      requestLog
        .map((entry) => entry.iface)
        .filter((iface) => ["gs.orderFlower.finishOrder", "gs.orderTeam.submitOrder"].includes(iface)),
      [
        "gs.orderFlower.finishOrder",
        "gs.orderTeam.submitOrder",
        "gs.orderFlower.finishOrder",
        "gs.orderTeam.submitOrder",
        "gs.orderFlower.finishOrder",
        "gs.orderTeam.submitOrder",
      ],
    );
    assert.equal(checkpointCount, 3);
    assert.equal(result.checkpointMarker, 3);
    assert.equal(requestLog.some((entry) => entry.args?.isCost === true), false);
    for (const finishEntry of requestLog.filter(
      (entry) => entry.iface === "gs.orderFlower.finishOrder",
    )) {
      const finishIndex = requestLog.indexOf(finishEntry);
      const checkpointIndex = requestLog.findIndex(
        (entry, index) => index > finishIndex && entry.iface === "gs.orderTeam.submitOrder",
      );
      const lazySyncIndex = requestLog.findIndex(
        (entry, index) => index > checkpointIndex && entry.iface === "gs.usr.lazySync",
      );
      const orderEnterIndex = requestLog.findIndex(
        (entry, index) => index > lazySyncIndex && entry.iface === "gs.orderFlower.enter",
      );
      assert.ok(checkpointIndex > finishIndex, "team checkpoint must follow each ordinary submit");
      assert.ok(lazySyncIndex > checkpointIndex, "lazySync must follow each team checkpoint");
      assert.ok(orderEnterIndex > lazySyncIndex, "orderFlower.enter must follow each lazySync");
    }

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.ordinaryResidentOrderSubmittedCount, 3);
    assert.equal(statusJson.ordinaryResidentOrders.submittedCount, 3);
    assert.equal(statusJson.ordinaryResidentOrders.mainTaskStatusAfter.canProgressResidentOrderMainTask, false);
    assert.equal(statusJson.ordinaryResidentOrders.pendingAutoSubmitActions.length, 0);
    assert.deepEqual(
      statusJson.ordinaryResidentOrders.orders
        .filter((order) => order.refillPending)
        .map((order) => [order.boxId, order.status, order.remainingMs]),
      [
        [301, "refill-cooldown", 42_000],
        [302, "refill-cooldown", 42_000],
        [303, "refill-cooldown", 42_000],
      ],
    );
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits ordinary resident orders with an unfinished level-up main task", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-level-up-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logs = [];
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  console.log = (line = "") => {
    logs.push(String(line));
  };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitOrdinaryResidentOrdersForLevelUp: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-level-up-cycle-test=${Date.now()}`);
    const task = getLevelUpMainTaskForTest();
    const taskId = Number(task.id);
    const targetValue = Number(task.value);
    const currentSync = {
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          bag: {
            7: 99,
            23001: 99,
          },
        },
        cntMap: {
          109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: {
        main: {
          curTaskId: taskId,
          curValue: targetValue - 1,
          recvMap: {},
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            501: { boxId: 501, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({ taskTot: currentSync.taskTot });
        if (iface === "gs.orderFlower.enter") return raw(currentSync);
        if (iface === "gs.orderFlower.finishOrder") {
          delete currentSync.orderFlowerTot.orderFlower.orderMap[args.boxId];
          return raw({
            taskTot: currentSync.taskTot,
            orderFlowerTot: currentSync.orderFlowerTot,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.orderFlower.finishOrder")
        .map((entry) => entry.args),
      [
        { boxId: 501 },
      ],
    );
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usr.lazySync"), true);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.orderFlower.enter"), true);

    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "ordinaryResidentOrderSubmitPlan" && entry.gateReason === "ordinary-order-ready" && entry.ordinaryAutoSubmitEnabled === true), true);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.ordinaryResidentOrderSubmittedCount, 1);
    assert.equal(statusJson.ordinaryResidentOrders.submittedCount, 1);
    assert.equal(statusJson.ordinaryResidentOrders.levelUpAutoSubmitEnabled, true);
    assert.equal(statusJson.ordinaryResidentOrders.mainTaskStatusAfter.isLevelUpMainTask, true);
    assert.equal(statusJson.ordinaryResidentOrders.mainTaskStatusAfter.canSubmitOrdinaryResidentOrderForMainTask, true);
    assert.equal(statusJson.ordinaryResidentOrders.pendingAutoSubmitActions.length, 0);
    assert.match(statusJson.ordinaryResidentOrders.autoSubmitRule, /independent of main-task type/);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle defaults to the inclusive 4-yuanbao threshold and stops before cost 8", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-material-shop-midnight-refresh-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const fixedNowMs = new Date(2026, 7, 3, 23, 55, 0).getTime();
  Date.now = () => fixedNowMs;
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_MATERIAL_SHOP: "1",
    AUTO_REFRESH_MATERIAL_SHOP_BEFORE_MIDNIGHT: "1",
    MATERIAL_SHOP_REFRESH_WINDOW_START: "23:50",
    MATERIAL_SHOP_REFRESH_WINDOW_END: "24:00",
    MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO: "4",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  let manualRefreshCount = 0;
  let yuanbao = 100;
  let gold = 1_000_000;
  let sold = false;
  const requestLog = [];
  const shopSnapshot = () => ({
    $usrTot: { data: { dmd: yuanbao, gld: gold, bag: {} } },
    shopCultivate: {
      mrCount: manualRefreshCount,
      infoMap: { 10001: [11, 100] },
      bRecord: sold ? { 10001: 1 } : {},
      larTime: "2026-08-03T12:00:00.000Z",
    },
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?material-shop-midnight-refresh-cycle-test=${Date.now()}`);
    const sync = makeSync({
      1001: {
        state: 2,
        flowerId: 23001,
        lvl: 2,
        nextTime: "2099-01-01T00:00:00.000Z",
      },
    }, 0);
    sync.$usrTot.data.dmd = yuanbao;
    sync.$usrTot.data.gld = gold;

    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.shopCultivate.enter") return raw(shopSnapshot());
        if (iface === "gs.shopCultivate.buy" && args.shopId === 10001) {
          gold -= 100;
          sold = true;
          return raw(shopSnapshot());
        }
        if (iface === "gs.shopCultivate.refresh") {
          const cost = manualRefreshCount < 3
            ? 0
            : 2 ** (manualRefreshCount - 3);
          yuanbao -= cost;
          manualRefreshCount += 1;
          sold = false;
          return raw(shopSnapshot());
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    const materialRequests = requestLog.filter((entry) => entry.iface.startsWith("gs.shopCultivate"));
    assert.equal(materialRequests.filter((entry) => entry.iface === "gs.shopCultivate.refresh").length, 6);
    assert.equal(materialRequests.filter((entry) => entry.iface === "gs.shopCultivate.enter").length, 7);
    assert.equal(materialRequests.filter((entry) => entry.iface === "gs.shopCultivate.buy").length, 7);
    const refreshIndices = materialRequests
      .map((entry, index) => entry.iface === "gs.shopCultivate.refresh" ? index : -1)
      .filter((index) => index >= 0);
    for (const refreshIndex of refreshIndices) {
      assert.equal(materialRequests[refreshIndex + 1]?.iface, "gs.shopCultivate.enter");
      assert.equal(materialRequests[refreshIndex + 2]?.iface, "gs.shopCultivate.buy");
    }
    assert.equal(manualRefreshCount, 6);
    assert.equal(yuanbao, 93);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.materialShopRefreshCount, 6);
    assert.equal(statusJson.summary.materialShopFreeRefreshCount, 3);
    assert.equal(statusJson.summary.materialShopPaidRefreshCount, 3);
    assert.equal(statusJson.summary.materialShopSpentYuanbao, 7);
    assert.equal(statusJson.materialShop.refresh.manualRefreshCount, 6);
    assert.equal(statusJson.materialShop.refresh.nextRefreshCostYuanbao, 8);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle stops material refresh without retry when a paid balance is not explicit", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-material-shop-refresh-unknown-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => new Date(2026, 7, 3, 23, 55, 0).getTime();
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_HANDLE_MATERIAL_SHOP: "1",
    AUTO_REFRESH_MATERIAL_SHOP_BEFORE_MIDNIGHT: "1",
    MATERIAL_SHOP_REFRESH_WINDOW_START: "23:50",
    MATERIAL_SHOP_REFRESH_WINDOW_END: "24:00",
    MATERIAL_SHOP_REFRESH_MAX_COST_YUANBAO: "4",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
  });

  let manualRefreshCount = 3;
  let refreshSubmitted = false;
  const requestLog = [];

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?material-shop-refresh-unknown-cycle-test=${Date.now()}`);
    const sync = makeSync({
      1001: {
        state: 2,
        flowerId: 23001,
        lvl: 2,
        nextTime: "2099-01-01T00:00:00.000Z",
      },
    }, 0);
    sync.$usrTot.data.dmd = 100;
    sync.$usrTot.data.gld = 1_000_000;

    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.shopCultivate.refresh") {
          refreshSubmitted = true;
          manualRefreshCount += 1;
          return raw({
            shopCultivate: { mrCount: manualRefreshCount, infoMap: {}, bRecord: {} },
          });
        }
        if (iface === "gs.shopCultivate.enter") {
          return raw({
            ...(refreshSubmitted ? {} : { $usrTot: { data: { dmd: 100, gld: 1_000_000, bag: {} } } }),
            shopCultivate: { mrCount: manualRefreshCount, infoMap: {}, bRecord: {} },
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

    assert.equal(
      requestLog.filter((entry) => entry.iface === "gs.shopCultivate.refresh").length,
      1,
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.materialShopRefreshCount, 0);
    assert.equal(statusJson.summary.materialShopRefreshFailedCount, 1);
    assert.equal(statusJson.summary.materialShopRefreshStopReason, "paid-balance-not-confirmed");
    assert.equal(statusJson.materialShop.refresh.manualRefreshCount, 4);
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle single-sample validation submits exactly one ordinary order without profile or special-order changes", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-single-sample-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logs = [];
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  console.log = (line = "") => {
    logs.push(String(line));
  };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitOrdinaryResidentOrdersForLevelUp: false,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    ACTION: "auto-loop",
    MAX_CYCLES: "1",
    ORDINARY_RESIDENT_ORDER_SINGLE_SAMPLE: "1",
    ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_GARDEN_LAND: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_WATER: "0",
    AUTO_SPEEDUP_FREE: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-single-sample-cycle-test=${Date.now()}`);
    const task = getLevelUpMainTaskForTest();
    const taskId = Number(task.id);
    const targetValue = Number(task.value);
    const currentSync = {
      ...makeSync({
        1001: {
          flowerId: 23001,
          state: 3,
          lvl: 2,
          nextTime: "2026-06-16T01:00:00.000Z",
          harvestCnt: 0,
        },
      }, 0),
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 1000000,
          nextExp: 10000000,
          bag: {
            7: 99,
            23001: 99,
          },
        },
        cntMap: {
          109: { type: 109, tdyCnt: 65, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 67, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: {
        main: {
          curTaskId: taskId,
          curValue: targetValue - 1,
          recvMap: {},
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            501: { boxId: 501, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
            502: { boxId: 502, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({ taskTot: currentSync.taskTot });
        if (iface === "gs.orderFlower.enter") return raw(currentSync);
        if (iface === "gs.orderFlower.finishOrder") {
          delete currentSync.orderFlowerTot.orderFlower.orderMap[args.boxId];
          return raw({
            taskTot: currentSync.taskTot,
            orderFlowerTot: currentSync.orderFlowerTot,
          });
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.orderFlower.finishOrder")
        .map((entry) => entry.args),
      [{ boxId: 501 }],
      JSON.stringify(parsedLogs.filter((entry) => /ordinaryResident|experience|cycleError/i.test(entry.step || ""))),
    );
    assert.equal(
      requestLog.some((entry) => [
        "gs.orderFlower.finishSatinOrder",
        "gs.orderFlower.finishDecorateOrder",
      ].includes(entry.iface)),
      false,
    );
    assert.equal(
      requestLog.some((entry) => [
        "gs.usrLand.harvest",
        "gs.usrLand.plant",
        "gs.usrLand.plantBatch",
        "gs.usrLand.water",
        "gs.usrLand.waterBatch",
      ].includes(entry.iface)),
      false,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(settingsPath, "utf8"))
        .autoSubmitOrdinaryResidentOrdersForLevelUp,
      false,
    );

    assert.equal(
      parsedLogs.some((entry) => (
        entry.step === "ordinaryResidentOrderSubmitPlan"
        && entry.singleSampleValidationEnabled === true
        && entry.specialDailyLimitBypassed === true
      )),
      true,
    );
    assert.equal(
      parsedLogs.some((entry) => entry.step === "ordinaryResidentOrderSubmitLimitReached" && entry.maxSteps === 1),
      true,
    );

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.ordinaryResidentOrderSubmittedCount, 1);
    assert.equal(statusJson.ordinaryResidentOrders.submittedCount, 1);
    assert.equal(statusJson.ordinaryResidentOrders.singleSampleValidationEnabled, true);
    assert.equal(statusJson.ordinaryResidentOrders.specialDailyLimitBypassed, true);
    assert.equal(statusJson.ordinaryResidentOrders.satinDailyLimitReached, false);
    assert.equal(statusJson.ordinaryResidentOrders.decorateDailyLimitReached, false);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle skips ordinary resident order submit when profile setting is disabled", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-setting-off-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const oldLog = console.log;
  const logs = [];
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  console.log = (line = "") => {
    logs.push(String(line));
  };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitOrdinaryResidentOrdersForLevelUp: false,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-setting-off-test=${Date.now()}`);
    const task = getLevelUpMainTaskForTest();
    const taskId = Number(task.id);
    const targetValue = Number(task.value);
    const currentSync = {
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          bag: {
            7: 99,
            23001: 99,
          },
        },
        cntMap: {
          109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: {
        main: {
          curTaskId: taskId,
          curValue: targetValue - 1,
          recvMap: {},
        },
      },
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            701: { boxId: 701, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.orderFlower.enter") return raw(currentSync);
        if (iface === "gs.orderFlower.finishOrder") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", currentSync, 1);

    assert.equal(requestLog.some((entry) => entry.iface === "gs.orderFlower.finishOrder"), false);
    const parsedLogs = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    assert.equal(parsedLogs.some((entry) => entry.step === "ordinaryResidentOrderSubmitSkip" && entry.reason === "ordinary-auto-submit-disabled-by-profile-setting"), true);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.ordinaryResidentOrders.ordinaryAutoSubmitEnabled, false);
    assert.equal(statusJson.ordinaryResidentOrders.levelUpAutoSubmitEnabled, false);
    assert.equal(statusJson.ordinaryResidentOrders.pendingAutoSubmitActions.length, 0);
    const ordinaryQueueRow = statusJson.automationQueue.rows.find((row) => row.area === "普通居民订单");
    assert.equal(ordinaryQueueRow.ordinaryAutoSubmitEnabled, false);
    assert.equal(ordinaryQueueRow.levelUpAutoSubmitEnabled, false);
    assert.match(ordinaryQueueRow.status, /自动提交普通居民订单开关关闭/);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not submit ordinary resident orders when the switch is disabled", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-resident-closed-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-resident-closed-cycle-test=${Date.now()}`);
    const task = getResidentOrderMainTaskForTest();
    const residentTaskId = Number(task.id);
    const targetValue = Number(task.value);
    const makeCurrentSync = (taskTotMain) => ({
      ...makeSync({}, 0),
      $usrTot: {
        data: {
          bag: {
            7: 99,
            23001: 99,
          },
        },
        cntMap: {
          109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: {
        main: taskTotMain,
      },
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            401: { boxId: 401, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
    });

    for (const sync of [
      makeCurrentSync({ curTaskId: 1, curValue: 0, recvMap: {} }),
      makeCurrentSync({ curTaskId: residentTaskId, curValue: targetValue, recvMap: {} }),
    ]) {
      const requestLog = [];
      const ws = {
        async request(iface, args) {
          requestLog.push({ iface, args });
          if (iface === "gs.usrLand.refresh") return raw(sync);
          if (iface === "gs.usr.heartTick") return raw({});
          if (iface === "gs.orderFlower.enter") return raw(sync);
          if (iface === "gs.orderFlower.finishOrder") return raw({});
          throw new Error(`unexpected iface ${iface}`);
        },
      };

      await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);
      assert.equal(requestLog.some((entry) => entry.iface === "gs.orderFlower.finishOrder"), false);
    }
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits ordinary resident orders with the switch on regardless of main-task state", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-main-task-independent-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitOrdinaryResidentOrdersForLevelUp: true,
    experienceGuardThresholdPercent: 0,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    EXPERIENCE_GUARD_STATE_PATH: path.join(outDir, "experience-guard.json"),
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "1",
    ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE: "1",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_GARDEN_LAND: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_WATER: "0",
    AUTO_SPEEDUP_FREE: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-main-task-independent-cycle-test=${Date.now()}`);
    const residentTask = getResidentOrderMainTaskForTest();
    const residentTaskId = Number(residentTask.id);
    const targetValue = Number(residentTask.value);
    const makeOrdinarySync = (taskMain, boxId) => {
      const base = makeSync({}, 99);
      return {
      ...base,
      $usrTot: {
        ...base.$usrTot,
        cntMap: {
          109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: taskMain == null ? {} : { main: taskMain },
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            [boxId]: { boxId, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
      };
    };
    const cases = [
      [null, 601],
      [{ curTaskId: 1, curValue: 0, recvMap: {} }, 602],
      [{ curTaskId: residentTaskId, curValue: targetValue, recvMap: {} }, 603],
      [{ curTaskId: residentTaskId, curValue: targetValue, recvMap: { [residentTaskId]: 1 } }, 604],
    ];

    for (const [taskMain, boxId] of cases) {
      const sync = makeOrdinarySync(taskMain, boxId);
      const requestLog = [];
      const ws = {
        async request(iface, args) {
          requestLog.push({ iface, args });
          if (iface === "gs.usrLand.refresh") return raw(sync);
          if (iface === "gs.usr.heartTick") return raw({});
          if (iface === "gs.usr.lazySync") return raw({ taskTot: sync.taskTot });
          if (iface === "gs.orderFlower.enter") return raw(sync);
          if (iface === "gs.orderFlower.finishOrder") return raw({});
          throw new Error(`unexpected iface ${iface}`);
        },
      };

      await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", sync, 1);

      assert.deepEqual(
        requestLog
          .filter((entry) => entry.iface === "gs.orderFlower.finishOrder")
          .map((entry) => entry.args),
        [{ boxId }],
        `expected ordinary order ${boxId} to submit for task state ${JSON.stringify(taskMain)}`,
      );
    }

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.ordinaryResidentOrders.ordinaryAutoSubmitEnabled, true);
    assert.equal(statusJson.ordinaryResidentOrders.ordinaryResidentOrderGateReason, "ordinary-order-ready");
    assert.match(
      statusJson.ordinaryResidentOrders.autoSubmitRule,
      /independent of main-task type, progress, and receive status/,
    );
    const ordinaryQueueRow = statusJson.automationQueue.rows.find(
      (row) => row.area === "普通居民订单",
    );
    assert.equal(ordinaryQueueRow?.gateReason, "ordinary-order-ready");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle records an ordinary order failure and stops the remaining ordinary batch", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-ordinary-failure-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  Date.now = () => Date.parse("2026-06-16T02:00:00.000Z");
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitOrdinaryResidentOrdersForLevelUp: true,
    experienceGuardThresholdPercent: 0,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    EXPERIENCE_GUARD_STATE_PATH: path.join(outDir, "experience-guard.json"),
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "1",
    ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE: "3",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?ordinary-failure-cycle-test=${Date.now()}`);
    const base = makeSync({}, 99);
    const sync = {
      ...base,
      $usrTot: {
        ...base.$usrTot,
        cntMap: {
          109: { type: 109, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
          116: { type: 116, tdyCnt: 121, rTime: "2026-06-16T01:00:00.000Z" },
        },
      },
      taskTot: {},
      orderFlowerTot: {
        orderFlower: {
          orderMap: {
            801: { boxId: 801, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
            802: { boxId: 802, flowers: [[23001, 1]], isVideo: 0, cdTime: "2026-06-16T01:00:00.000Z" },
          },
          orderSatin: {},
          orderDecorate: {},
        },
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(sync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({ taskTot: sync.taskTot });
        if (iface === "gs.orderFlower.enter") return raw(sync);
        if (iface === "gs.orderFlower.finishOrder") throw new Error("ordinary-finish-failed");
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(ws, "test-token", sync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.orderFlower.finishOrder")
        .map((entry) => entry.args),
      [{ boxId: 801 }],
    );
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.ordinaryResidentOrders.submittedCount, 0);
    assert.equal(statusJson.ordinaryResidentOrders.failedActions.length, 1);
    assert.equal(statusJson.ordinaryResidentOrders.failedActions[0].message, "ordinary-finish-failed");
  } finally {
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle submits one ready cyclic story order and re-enters after success", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-story-submit-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({ autoSubmitCyclicStoryOrders: true }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-story-submit-cycle-test=${Date.now()}`);
    const config = loadCyclicStoryConfig();
    const orderCfg = config.orders.get(1);
    const batchId = 99001;
    const initialSync = {
      ...makeSync({}, orderCfg.cost + 20),
      ...makeCyclicStorySync({
        batchId,
        expOrderNum: 12,
        orderInfo: {
          0: { orderId: 1, flowerId: 23001, validTime: Date.now() - 1 },
        },
      }),
    };
    const afterSubmitSync = makeCyclicStorySync({
      batchId,
      expOrderNum: 13,
      orderInfo: {},
      score: 29,
    });
    const { requestLog, ws } = makeCyclicStoryRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync, afterSubmitSync],
      recvOrderRwdResponses: [{}],
      lazySyncResponses: [{
        $usrTot: { data: { lvl: 40, lvlExp: 1_000_000, nextExp: 10_000_000 } },
      }],
    });

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.actCyclicStory."))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.actCyclicStory.enter", { batchId }],
        ["gs.actCyclicStory.recvOrderRwd", { batchId, orderIdx: 0 }],
        ["gs.actCyclicStory.enter", { batchId }],
      ],
    );
    assert.deepEqual(result.actTot.map[batchId].ext.cyclicStory.orderInfo, {});

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.cyclicStorySubmittedCount, 1);
    assert.equal(statusJson.cyclicStory.submittedCount, 1);
    assert.equal(statusJson.cyclicStory.expOrderNum, 13);
    assert.equal(
      statusJson.automationQueue.rows.some((row) => row.area === "莳花纪闻"),
      true,
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle highest experience strategy submits only the initial enter winner", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-story-highest-experience-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoSubmitCyclicStoryOrders: true,
    cyclicStoryOnlyHighestExperienceOrder: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-story-highest-experience-cycle-test=${Date.now()}`);
    const config = loadCyclicStoryConfig();
    const flower = config.flowers.get(23001);
    const orderInfo = {
      0: { orderId: 1, flowerId: 23001, validTime: Date.now() - 1 },
      1: { orderId: 2, flowerId: 23001, validTime: Date.now() - 1 },
      2: { orderId: 3, flowerId: 23001, validTime: Date.now() - 1 },
    };
    const batchId = 99004;
    const initialSync = {
      ...makeSync({}, 1_000),
      ...makeCyclicStorySync({ batchId, expOrderNum: 12, orderInfo }),
    };
    const afterSubmitSync = makeCyclicStorySync({
      batchId,
      expOrderNum: 13,
      orderInfo: {
        0: { orderId: 1, flowerId: 23001, validTime: Date.now() - 1 },
        1: { orderId: 2, flowerId: 23001, validTime: Date.now() - 1 },
      },
    });
    const expectedExperience = [1, 2, 3].map((orderId) => Math.ceil(
      flower.exp * config.orders.get(orderId).cost * config.globals.expValue,
    ));
    const winnerOrderIdx = expectedExperience.indexOf(Math.max(...expectedExperience));
    const { requestLog, ws } = makeCyclicStoryRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync, afterSubmitSync],
      recvOrderRwdResponses: [{}],
      lazySyncResponses: [{
        $usrTot: { data: { lvl: 40, lvlExp: 1_000_000, nextExp: 10_000_000 } },
      }],
    });

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.actCyclicStory."))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.actCyclicStory.enter", { batchId }],
        ["gs.actCyclicStory.recvOrderRwd", { batchId, orderIdx: winnerOrderIdx }],
        ["gs.actCyclicStory.enter", { batchId }],
      ],
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle skips cyclic story submission when the profile switch is off", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-story-switch-off-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  fs.writeFileSync(settingsPath, JSON.stringify({ autoSubmitCyclicStoryOrders: false }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });
  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-story-switch-off-cycle-test=${Date.now()}`);
    const config = loadCyclicStoryConfig();
    const orderCfg = config.orders.get(1);
    const batchId = 99003;
    const initialSync = {
      ...makeSync({}, orderCfg.cost + 20),
      ...makeCyclicStorySync({
        batchId,
        expOrderNum: 12,
        orderInfo: { 0: { orderId: 1, flowerId: 23001, validTime: Date.now() - 1 } },
      }),
    };
    const { requestLog, ws } = makeCyclicStoryRequestFixture({
      refreshSync: initialSync,
      lazySyncResponses: [{ $usrTot: { data: { lvl: 40, lvlExp: 1_000_000, nextExp: 10_000_000 } } }],
    });
    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);
    assert.equal(requestLog.some((entry) => entry.iface.startsWith("gs.actCyclicStory.")), false, "expected no cyclic story requests when the profile switch is off");
    const skipLog = logs.find((line) => {
      try { return JSON.parse(line).step === "cyclicStorySkip"; } catch { return false; }
    });
    assert.ok(skipLog, "expected a cyclicStorySkip log");
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.cyclicStory.autoSubmitEnabled, false);
    assert.deepEqual(statusJson.cyclicStory.pendingAutoSubmitActions, []);
    const row = statusJson.automationQueue.rows.find((item) => item.area === "莳花纪闻");
    assert.equal(row.pending, 0);
    assert.equal(row.state, "idle");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle lets experience protection block cyclic story submission", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-story-exp-block-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({ autoSubmitCyclicStoryOrders: true }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-story-exp-block-cycle-test=${Date.now()}`);
    const config = loadCyclicStoryConfig();
    const orderCfg = config.orders.get(1);
    const batchId = 99002;
    const initialSync = {
      ...makeSync({}, orderCfg.cost),
      ...makeCyclicStorySync({
        batchId,
        expOrderNum: 399,
        orderInfo: {
          0: { orderId: 1, flowerId: 23001, validTime: Date.now() - 1 },
        },
      }),
    };
    initialSync.$usrTot.data.lvlExp = 9_948_000;
    initialSync.$usrTot.data.nextExp = 10_000_000;
    const { requestLog, ws } = makeCyclicStoryRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      lazySyncResponses: [{
        $usrTot: { data: { lvl: 40, lvlExp: 9_948_000, nextExp: 10_000_000 } },
      }],
    });

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.equal(
      requestLog.some((entry) => entry.iface === "gs.actCyclicStory.recvOrderRwd"),
      false,
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle receives one ready cyclic note task from its callback sync", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-receive-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-receive-cycle-test=${Date.now()}`);
    const [readyTask, receivedTaskOne, receivedTaskTwo, replacementTask] = getCyclicNoteTasksForTest(4);
    const batchId = 88001;
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId,
        taskList: [readyTask.id, receivedTaskOne.id, receivedTaskTwo.id],
        progress: {
          [readyTask.id]: readyTask.value,
          [receivedTaskOne.id]: receivedTaskOne.value,
          [receivedTaskTwo.id]: receivedTaskTwo.value,
        },
        recvMap: { [receivedTaskOne.id]: 1, [receivedTaskTwo.id]: 1 },
        score: 25,
      }),
    };
    const receiveResponse = {
      actTot: {
        map: {
          [batchId]: {
            score: 28,
            ext: { cyclicNote: { taskList: [replacementTask.id, receivedTaskOne.id, receivedTaskTwo.id] } },
          },
        },
        taskRcdMap: {
          [`${batchId}|0`]: {
            progress: {
              [replacementTask.id]: 0,
              [receivedTaskOne.id]: receivedTaskOne.value,
              [receivedTaskTwo.id]: receivedTaskTwo.value,
            },
            recvMap: { [receivedTaskOne.id]: 1, [receivedTaskTwo.id]: 1 },
          },
        },
      },
    };
    const { requestLog, ws } = makeCyclicNoteRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      recvTaskRwdResponses: [receiveResponse],
      lazySyncResponses: [{}],
    });

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.actCyclicNote."))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.actCyclicNote.enter", { batchId }],
        ["gs.actCyclicNote.recvTaskRwd", { batchId, taskId: readyTask.id }],
      ],
    );
    assert.equal(result.actTot.map[batchId].score, 28);
    assert.equal(result.actTot.map[batchId].bms, initialSync.actTot.map[batchId].bms);
    assert.equal(result.actTot.map[batchId].ems, initialSync.actTot.map[batchId].ems);
    assert.deepEqual(result.$timeAuthority, initialSync.$timeAuthority);
    assert.deepEqual(result.actTot.map[batchId].ext.cyclicNote.taskList, [
      replacementTask.id,
      receivedTaskOne.id,
      receivedTaskTwo.id,
    ]);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.cyclicNoteReceivedCount, 1);
    assert.equal(statusJson.cyclicNote.receivedCount, 1);
    assert.equal(statusJson.cyclicNote.failedCount, 0);
    assert.deepEqual(statusJson.cyclicNote.taskSlots.map((slot) => slot.taskId), [
      replacementTask.id,
      receivedTaskOne.id,
      receivedTaskTwo.id,
    ]);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle natural cyclic-note target coexists with normal harvest and special order modules", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-natural-harvest-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_CYCLIC_NOTE: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "1",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-natural-harvest-cycle-test=${Date.now()}`);
    const checkpointTimeline = [];
    const teamOrderRuntime = {
      bind() {},
      capability() { return { ready: true, enabled: true }; },
      config: {},
      runner: {
        async handle(syncValue, context) {
          checkpointTimeline.push(context.trigger);
          return { syncValue, handled: false, finalReason: "idle" };
        },
      },
      takeFatalError() { return null; },
    };
    const harvestTask = [...loadCyclicNoteConfig().actCyclicNote.values()]
      .find((task) => Number(task.type) === 3002);
    assert.ok(harvestTask, "expected a bundled cyclic-note harvest task");
    const fillerTasks = [...loadCyclicNoteConfig().actCyclicNote.values()]
      .filter((task) => Number(task.id) !== Number(harvestTask.id))
      .slice(0, 2);
    assert.equal(fillerTasks.length, 2, "expected two bundled cyclic-note filler tasks");
    const taskIds = [Number(harvestTask.id), ...fillerTasks.map((task) => Number(task.id))];
    const initialProgress = Object.fromEntries(taskIds.map((taskId) => [taskId, 0]));
    const batchId = 88101;
    const landMap = {
      1001: {
        landId: 1001,
        flowerId: 23001,
        state: 3,
        harvestCnt: 1,
        nextTime: "2026-06-16T01:00:00.000Z",
      },
    };
    const initialSync = {
      ...makeSync(landMap, 99),
      ...makeCyclicNoteSync({
        batchId,
        taskList: taskIds,
        progress: initialProgress,
        recvMap: {},
      }),
      orderFlowerTot: {
        orderFlower: {
          orderSatin: {
            flowers: [[23001, 5]],
            finishCnt: 63,
            isVideo: 0,
            cTime: "2026-06-16T00:00:00.000Z",
            cdTime: "2026-06-16T00:00:00.000Z",
          },
        },
      },
    };
    const afterHarvestEnterSync = {
      ...initialSync,
      ...makeCyclicNoteSync({
        batchId,
        taskList: taskIds,
        progress: { ...initialProgress, [Number(harvestTask.id)]: 1 },
        recvMap: {},
      }),
    };
    initialSync.$usrTot.data.id = "cyclic-note-natural-test";
    afterHarvestEnterSync.$usrTot.data.id = "cyclic-note-natural-test";
    const requestLog = [];
    const cyclicTargetCalls = [];
    const enterResponses = [initialSync, afterHarvestEnterSync];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(initialSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.actCyclicNote.enter") return raw(enterResponses.shift() || afterHarvestEnterSync);
        if (iface === "gs.orderFlower.enter") return raw(initialSync);
        if (iface === "gs.orderFlower.finishSatinOrder") return raw({});
        if (iface === "gs.usrLand.harvest") {
          checkpointTimeline.push("normal-harvest");
          return raw({});
        }
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1, {
      teamOrderRuntime,
      cyclicNoteTaskHandler: async ({ target, syncValue }) => {
        cyclicTargetCalls.push(target);
        return { syncValue, actionCount: 1, actions: [{ taskId: target.taskId }] };
      },
    });

    assert.equal(checkpointTimeline.includes("normal-harvest"), true);
    const harvestArgs = requestLog
      .filter((entry) => entry.iface === "gs.usrLand.harvest")
      .map((entry) => entry.args);
    assert.equal(harvestArgs.length >= 1, true);
    assert.equal(harvestArgs.every((args) => args.landId === 1001), true);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.orderFlower.enter"), true);
    assert.deepEqual(cyclicTargetCalls.map((target) => target.taskId), [Number(harvestTask.id)]);
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.actCyclicNote."))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.actCyclicNote.enter", { batchId }],
        ["gs.actCyclicNote.enter", { batchId }],
      ],
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle keeps its scheduled cyclic-note target after an active team checkpoint", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-team-priority-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_CYCLIC_NOTE: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
  });
  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-team-priority=${Date.now()}`);
    const [harvestTask, fillerOne, fillerTwo] = getCyclicNoteTasksForTest(3);
    const batchId = 88103;
    const syncValue = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId,
        taskList: [harvestTask.id, fillerOne.id, fillerTwo.id],
        progress: { [harvestTask.id]: 0, [fillerOne.id]: 0, [fillerTwo.id]: 0 },
        recvMap: {},
      }),
    };
    const timeline = [];
    const teamOrderRuntime = {
      bind() {},
      capability() { return { ready: true, enabled: true }; },
      config: {},
      runner: {
        async handle(current, context) {
          timeline.push(context.trigger);
          return { syncValue: current, handled: true, finalReason: "idle" };
        },
      },
      takeFatalError() { return null; },
    };
    const requestLog = [];
    const cyclicTargetCalls = [];
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usrLand.refresh") return raw(syncValue);
        if (iface === "gs.usr.heartTick" || iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.actCyclicNote.enter") return raw(syncValue);
        throw new Error(`unexpected iface: ${iface}`);
      },
    };
    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", syncValue, 1, {
      teamOrderRuntime,
      cyclicNoteTaskHandler: async ({ target, syncValue: next }) => {
        cyclicTargetCalls.push(target);
        return { syncValue: next, actionCount: 1, actions: [{ taskId: target.taskId }] };
      },
    });
    assert.deepEqual(timeline, ["startup"]);
    assert.equal(cyclicTargetCalls.length, 1);
    assert.deepEqual(
      requestLog.filter((iface) => iface.startsWith("gs.actCyclicNote.")),
      ["gs.actCyclicNote.enter", "gs.actCyclicNote.enter"],
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle processes all supported cyclic-note tasks when the child strategy is disabled", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-natural-disabled-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: false,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_CYCLIC_NOTE: "1",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
  });
  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-natural-disabled=${Date.now()}`);
    const [harvestTask, fillerOne, fillerTwo] = getCyclicNoteTasksForTest(3);
    const batchId = 88105;
    const syncValue = {
      ...makeSync({
        1001: {
          landId: 1001,
          flowerId: 23001,
          state: 3,
          harvestCnt: 1,
          nextTime: "2026-06-16T01:00:00.000Z",
        },
      }, 0),
      ...makeCyclicNoteSync({
        batchId,
        taskList: [harvestTask.id, fillerOne.id, fillerTwo.id],
        progress: { [harvestTask.id]: 0, [fillerOne.id]: 0, [fillerTwo.id]: 0 },
        recvMap: {},
      }),
    };
    const requestLog = [];
    const cyclicTargetCalls = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        if (iface === "gs.usrLand.refresh") return raw(syncValue);
        if (iface === "gs.usr.heartTick" || iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.actCyclicNote.enter") return raw(syncValue);
        if (iface === "gs.usrLand.harvest") return raw({});
        throw new Error(`unexpected iface: ${iface}`);
      },
    };

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", syncValue, 1, {
      cyclicNoteTaskHandler: async ({ target, syncValue: next }) => {
        cyclicTargetCalls.push(target);
        return { syncValue: next, actionCount: 1, actions: [{ taskId: target.taskId }] };
      },
    });

    assert.deepEqual(cyclicTargetCalls.map((target) => target.taskId), [harvestTask.id]);
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.actCyclicNote."))
        .map((entry) => entry.iface),
      ["gs.actCyclicNote.enter", "gs.actCyclicNote.enter"],
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle fails closed when the startup team checkpoint throws", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-team-error-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: true,
  }), "utf8");
  assignCycleEnv({ STATUS_DOC_DIR: outDir, PROFILE_SETTINGS_PATH: settingsPath, AUTO_HANDLE_CYCLIC_NOTE: "1" });
  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-team-error=${Date.now()}`);
    const [taskOne, taskTwo, taskThree] = getCyclicNoteTasksForTest(3);
    const syncValue = {
      ...makeSync({ 1001: { landId: 1001, flowerId: 23001, state: 3, harvestCnt: 1 } }, 0),
      ...makeCyclicNoteSync({
        batchId: 88104,
        taskList: [taskOne.id, taskTwo.id, taskThree.id],
        progress: { [taskOne.id]: 0, [taskTwo.id]: 0, [taskThree.id]: 0 },
        recvMap: {},
      }),
    };
    const requestLog = [];
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usrLand.refresh") return raw(syncValue);
        if (iface === "gs.usr.heartTick") return raw({});
        throw new Error(`unexpected request after checkpoint failure: ${iface}`);
      },
    };
    const teamOrderRuntime = {
      bind() {},
      capability() { return { ready: true, enabled: true }; },
      config: {},
      runner: { async handle() { throw new Error("team-checkpoint-failed"); } },
      takeFatalError() { return null; },
    };
    await assert.rejects(
      runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", syncValue, 1, { teamOrderRuntime }),
      /team-checkpoint-failed/,
    );
    assert.equal(requestLog.some((iface) => iface === "gs.usrLand.harvest" || iface.startsWith("gs.actCyclicNote.")), false);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not receive a replacement cyclic note task in the same callback cycle", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-single-receive-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-single-receive-cycle-test=${Date.now()}`);
    const [firstTask, secondTask, thirdTask, replacementTask] = getCyclicNoteTasksForTest(4);
    const batchId = 88002;
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId,
        taskList: [firstTask.id, secondTask.id, thirdTask.id],
        progress: { [firstTask.id]: firstTask.value, [secondTask.id]: 0, [thirdTask.id]: 0 },
        recvMap: {},
        score: 18,
      }),
    };
    const receiveResponse = {
      actTot: {
        map: {
          [batchId]: {
            score: 20,
            ext: { cyclicNote: { taskList: [replacementTask.id, secondTask.id, thirdTask.id] } },
          },
        },
        taskRcdMap: {
          [`${batchId}|0`]: {
            progress: { [replacementTask.id]: 0, [secondTask.id]: 0, [thirdTask.id]: 0 },
            recvMap: {},
          },
        },
      },
    };
    const { requestLog, ws } = makeCyclicNoteRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      recvTaskRwdResponses: [receiveResponse],
      lazySyncResponses: [{}],
    });

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface.startsWith("gs.actCyclicNote."))
        .map((entry) => [entry.iface, entry.args]),
      [
        ["gs.actCyclicNote.enter", { batchId }],
        ["gs.actCyclicNote.recvTaskRwd", { batchId, taskId: firstTask.id }],
      ],
    );
    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.actCyclicNote.recvTaskRwd")
        .map((entry) => entry.args),
      [
        { batchId, taskId: firstTask.id },
      ],
    );
    assert.equal(result.actTot.map[batchId].score, 20);
    assert.equal(result.actTot.map[batchId].bms, initialSync.actTot.map[batchId].bms);
    assert.equal(result.actTot.map[batchId].ems, initialSync.actTot.map[batchId].ems);
    assert.deepEqual(result.$timeAuthority, initialSync.$timeAuthority);
    assert.deepEqual(result.actTot.map[batchId].ext.cyclicNote.taskList, [
      replacementTask.id,
      secondTask.id,
      thirdTask.id,
    ]);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.cyclicNote.receivedCount, 1);
    assert.equal(statusJson.cyclicNote.failedCount, 0);
    assert.deepEqual(statusJson.cyclicNote.taskSlots.map((slot) => slot.taskId), [
      replacementTask.id,
      secondTask.id,
      thirdTask.id,
    ]);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle records one failed cyclic note receive action and stops further receives for the cycle", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-failed-receive-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-failed-receive-cycle-test=${Date.now()}`);
    const [firstTask, secondTask, thirdTask] = getCyclicNoteTasksForTest(3);
    const batchId = 88003;
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId,
        taskList: [firstTask.id, secondTask.id, thirdTask.id],
        progress: {
          [firstTask.id]: firstTask.value,
          [secondTask.id]: secondTask.value,
          [thirdTask.id]: 0,
        },
        recvMap: {},
      }),
    };
    const { requestLog, ws } = makeCyclicNoteRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      recvTaskRwdResponses: [new Error("cyclic note receive failed"), {}],
      lazySyncResponses: [{}, {}],
    });

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.deepEqual(
      requestLog
        .filter((entry) => entry.iface === "gs.actCyclicNote.recvTaskRwd")
        .map((entry) => entry.args),
      [
        { batchId, taskId: firstTask.id },
      ],
    );

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.cyclicNote.failedActions.length, 1);
    assert.equal(statusJson.cyclicNote.failedActions[0].taskId, firstTask.id);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle writes active cyclic note status JSON and automation queue details", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-status-json-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: false,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-status-json-cycle-test=${Date.now()}`);
    const [firstReadyTask, pendingTask, secondReadyTask] = getCyclicNoteTasksForTest(3);
    const batchId = 88007;
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId,
        taskList: [firstReadyTask.id, pendingTask.id, secondReadyTask.id],
        progress: {
          [firstReadyTask.id]: firstReadyTask.value,
          [pendingTask.id]: Math.max(0, pendingTask.value - 1),
          [secondReadyTask.id]: secondReadyTask.value,
        },
        recvMap: {},
      }),
    };
    const { ws } = makeCyclicNoteRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      recvTaskRwdResponses: [new Error("cyclic note receive failed")],
      lazySyncResponses: [{}],
    });

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.cyclicNote.active, true);
    assert.equal(typeof statusJson.cyclicNote.autoReceiveRule, "string");
    assert.match(statusJson.cyclicNote.autoReceiveRule, /active phase only/i);
    assert.match(statusJson.cyclicNote.autoReceiveRule, /never direct-finish, reroll, unlock, gift, box, or shop/i);
    assert.equal(Array.isArray(statusJson.cyclicNote.pendingReceiveActions), true);
    assert.equal(statusJson.cyclicNote.pendingReceiveActions.length <= 3, true);
    assert.deepEqual(
      statusJson.cyclicNote.pendingReceiveActions.map((action) => action.taskId),
      [firstReadyTask.id, secondReadyTask.id],
    );
    assert.deepEqual(
      {
        cyclicNoteActionCount: statusJson.summary.cyclicNoteActionCount,
        cyclicNoteReceivedCount: statusJson.summary.cyclicNoteReceivedCount,
        cyclicNoteFailedCount: statusJson.summary.cyclicNoteFailedCount,
      },
      {
        cyclicNoteActionCount: 1,
        cyclicNoteReceivedCount: 0,
        cyclicNoteFailedCount: 0,
      },
    );

    const cyclicNoteRows = statusJson.automationQueue.rows.filter((row) => row.area === "花笺集芳");
    assert.equal(cyclicNoteRows.length, 1);
    assert.match(cyclicNoteRows[0].rule, /刷新星级/);
    assert.match(cyclicNoteRows[0].rule, /解锁/);
    assert.match(cyclicNoteRows[0].rule, /立即完成/);
    assert.match(cyclicNoteRows[0].rule, /礼包/);
    assert.match(cyclicNoteRows[0].rule, /宝箱/);
    assert.match(cyclicNoteRows[0].rule, /商店/);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle does not call cyclic note recvTaskRwd for inactive phase, missing batchId, or missing task config", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-no-recv-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-no-recv-cycle-test=${Date.now()}`);
    const [readyTask] = getCyclicNoteTasksForTest(1);
    const missingTaskId = readyTask.id + 999999;
    const cases = [
      {
        name: "inactive-phase",
        sync: {
          ...makeSync({}, 0),
          ...makeCyclicNoteSync({
            batchId: 88004,
            phase: 1,
            taskList: [readyTask.id],
            progress: { [readyTask.id]: readyTask.value },
            recvMap: {},
          }),
        },
      },
      {
        name: "missing-batch-id",
        sync: {
          ...makeSync({}, 0),
          ...makeCyclicNoteSync({
            includeBatchId: false,
            mapKey: "missing-batch-id",
            taskList: [readyTask.id],
            progress: { [readyTask.id]: readyTask.value },
            recvMap: {},
          }),
        },
      },
      {
        name: "missing-task-config",
        sync: {
          ...makeSync({}, 0),
          ...makeCyclicNoteSync({
            batchId: 88005,
            taskList: [missingTaskId],
            progress: { [missingTaskId]: readyTask.value },
            recvMap: {},
          }),
        },
      },
    ];

    for (const entry of cases) {
      const { requestLog, ws } = makeCyclicNoteRequestFixture({
        refreshSync: entry.sync,
        enterResponses: [entry.sync],
        lazySyncResponses: [{}],
      });
      await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", entry.sync, 1);
      assert.equal(
        requestLog.some((item) => item.iface === "gs.actCyclicNote.recvTaskRwd"),
        false,
        `${entry.name} should not request gs.actCyclicNote.recvTaskRwd`,
      );
    }
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle omits cyclic note automation queue rows when the activity is not active", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-inactive-status-json-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-inactive-status-json-cycle-test=${Date.now()}`);
    const [readyTask] = getCyclicNoteTasksForTest(1);
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
          batchId: 88008,
          phase: 1,
          bms: Date.now() + 60_000,
          ems: Date.now() + 120_000,
        taskList: [readyTask.id],
        progress: { [readyTask.id]: readyTask.value },
        recvMap: {},
      }),
    };
    const { ws } = makeCyclicNoteRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      lazySyncResponses: [{}],
    });

    await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(
      statusJson.automationQueue.rows.some((row) => row.area === "花笺集芳"),
      false,
    );
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle closes cyclic-note receive and natural routes when time authority is expired", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-expired-authority-"));
  const settingsPath = path.join(outDir, "profile-settings.json");
  const oldEnv = { ...process.env };
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: true,
  }), "utf8");
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    PROFILE_SETTINGS_PATH: settingsPath,
    AUTO_HANDLE_CYCLIC_NOTE: "1",
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });
  try {
    const { runGardenCycle } = await import(`./inspect-garden-dryrun.mjs?cyclic-note-expired-authority=${Date.now()}`);
    const [readyTask, fillerOne, fillerTwo] = getCyclicNoteTasksForTest(3);
    const nowMs = Date.now();
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId: 88009,
        bms: nowMs - 60_000,
        ems: nowMs + 60_000,
        taskList: [readyTask.id, fillerOne.id, fillerTwo.id],
        progress: { [readyTask.id]: readyTask.value, [fillerOne.id]: 0, [fillerTwo.id]: 0 },
        recvMap: {},
        timeAuthority: makeTrustedTimeAuthority(nowMs - 300_000),
      }),
    };
    const { requestLog, ws } = makeCyclicNoteRequestFixture({ refreshSync: initialSync });

    const result = await runGardenCycle(withDefaultExperienceLazySync(ws), "test-token", initialSync, 1);

    assert.equal(requestLog.some((entry) => entry.iface.startsWith("gs.actCyclicNote.")), false);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.harvest"), false);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.cyclicNote.timeTrusted, false);
    assert.equal(statusJson.cyclicNote.executionSafe, false);
    assert.deepEqual(statusJson.cyclicNote.pendingReceiveActions, []);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle allows configured zero-exp cyclic note reward one point below the 0.5 percent boundary", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-cyclic-note-experience-guard-"));
  const oldEnv = { ...process.env };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?cyclic-note-experience-guard-cycle-test=${Date.now()}`
    );
    const [readyTask, fillerOne, fillerTwo] = getCyclicNoteTasksForTest(3);
    const initialSync = {
      ...makeSync({}, 0),
      ...makeCyclicNoteSync({
        batchId: 88006,
          taskList: [readyTask.id, fillerOne.id, fillerTwo.id],
          progress: { [readyTask.id]: readyTask.value, [fillerOne.id]: 0, [fillerTwo.id]: 0 },
        recvMap: {},
      }),
    };
    initialSync.$usrTot.data.lvlExp = 9949999;
    initialSync.$usrTot.data.nextExp = 10000000;
    const { requestLog, ws } = makeCyclicNoteRequestFixture({
      refreshSync: initialSync,
      enterResponses: [initialSync],
      lazySyncResponses: [{}],
    });

    await runGardenCycle(
      withDefaultExperienceLazySync(ws, { allowUnknownExperience: true }),
      "test-token",
      initialSync,
      1,
    );

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usr.lazySync"), true);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.actCyclicNote.recvTaskRwd"), true);
  } finally {
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle skips boundary-reaching harvest and continues a later non-experience action", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-experience-guard-"));
  const oldEnv = { ...process.env };
  const oldNow = Date.now;
  const nowMs = Date.parse("2026-06-16T12:00:00.000Z");
  Date.now = () => nowMs;
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_HANDLE_FREE_WATER: "1",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?experience-guard-cycle-test=${Date.now()}`
    );
    const landMap = Object.fromEntries([
      [1001, {
        landId: 1001,
        flowerId: 23001,
        state: 3,
        harvestCnt: 1,
        nextTime: "2026-06-16T01:00:00.000Z",
      }],
      ...Array.from({ length: 16 }, (_, index) => [1002 + index, {}]),
    ]);
    const currentSync = {
      ...makeSync(landMap, 0),
      $usrTot: {
        data: {
          lvl: 40,
          lvlExp: 9949990,
          nextExp: 10000000,
          bag: {
            7: 0,
            23001: 99,
          },
        },
      },
      freeWater: {
        recvIdx: [],
        rTime: "2026-06-16T12:00:00.000Z",
      },
    };
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        assert.notEqual(iface, "gs.usrLand.harvest", "harvest should be blocked at the strict boundary");
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        if (iface === "gs.freeWater.recv") {
          return raw({
            $usrTot: {
              itemAddChg: {
                itemMap: {
                  [ITEM_IDS.WATER_DROP]: 30,
                },
              },
            },
            freeWater: {
              recvIdx: [args.idx],
              rTime: "2026-06-16T12:00:00.000Z",
            },
          });
        }
        if (iface === "gs.usrLand.plant" || iface === "gs.usrLand.water") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws, { allowUnknownExperience: true }),
      "test-token",
      currentSync,
      1,
    );

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usr.lazySync"), true);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.harvest"), false);
    assert.equal(
      requestLog.some((entry) => entry.iface === "gs.freeWater.recv"),
      true,
      "a later non-experience business action should still run",
    );
    const parsedLogs = logs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const skip = parsedLogs.find((entry) => entry.step === "experienceGuardActionSkip");
    assert.equal(skip?.reason, "experience-protection-boundary");
    const statusJson = JSON.parse(
      fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"),
    );
    assert.equal(statusJson.summary?.automationStopped, null);
  } finally {
    console.log = oldLog;
    Date.now = oldNow;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("runGardenCycle skips an experience action with unknown account experience without stopping the cycle", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-experience-unknown-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => {
    logs.push(String(line));
  };
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_HANDLE_FREE_WATER: "0",
  });

  try {
    const { runGardenCycle } = await import(
      `./inspect-garden-dryrun.mjs?experience-unknown-cycle-test=${Date.now()}`
    );
    const currentSync = makeSync({
      1001: {
        landId: 1001,
        flowerId: 23001,
        state: 3,
        harvestCnt: 1,
        nextTime: "2026-06-16T01:00:00.000Z",
      },
    }, 99);
    delete currentSync.$usrTot.data.lvl;
    delete currentSync.$usrTot.data.lvlExp;
    delete currentSync.$usrTot.data.nextExp;
    const requestLog = [];
    const ws = {
      async request(iface, args) {
        requestLog.push({ iface, args });
        assert.notEqual(iface, "gs.usrLand.harvest", "harvest must be skipped when experience is unknown");
        if (iface === "gs.usrLand.refresh") return raw(currentSync);
        if (iface === "gs.usr.heartTick") return raw({});
        if (iface === "gs.usr.lazySync") return raw({});
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await runGardenCycle(
      withDefaultExperienceLazySync(ws, { allowUnknownExperience: true }),
      "test-token",
      currentSync,
      1,
    );

    assert.equal(requestLog.some((entry) => entry.iface === "gs.usr.lazySync"), true);
    assert.equal(requestLog.some((entry) => entry.iface === "gs.usrLand.harvest"), false);
    const parsedLogs = logs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const skip = parsedLogs.find((entry) => entry.step === "experienceGuardActionSkip");
    assert.equal(skip?.reason, "account-experience-unknown");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("experience action blocking is visible in cycle errors and module health", async (t) => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "garden-cycle-experience-blocked-status-"));
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  console.log = () => {};
  assignCycleEnv({
    STATUS_DOC_DIR: outDir,
    AUTO_SUBMIT_SPECIAL_ORDERS: "0",
    AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_MAIN_TASKS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_SPEEDUP_FREE: "0",
    AUTO_WATER: "0",
  });

  try {
    const [garden, { createPersistentExperienceLevelGuard }, { createAutomationModuleHealthRegistry }] = await Promise.all([
      import(`./inspect-garden-dryrun.mjs?experience-blocked-status=${Date.now()}`),
      import("./experience-guard-state.mjs"),
      import("./automation-module-health.mjs"),
    ]);
    const currentSync = makeSync({
      1001: {
        landId: 1001,
        flowerId: 23001,
        state: 3,
        harvestCnt: 1,
        nextTime: "2026-06-16T01:00:00.000Z",
      },
    }, 99);
    const statePath = path.join(outDir, "experience-guard.json");
    const guard = createPersistentExperienceLevelGuard({ profileId: "main", statePath });
    guard.observeAuthoritative({ level: 40, currentExp: 100, requiredExp: 10_000, enabled: true });
    guard.beginProtectedAction({ requestId: "unknown-harvest", iface: "gs.usrLand.harvest", actionArgs: { landId: 1001 } });
    guard.markProtectedActionUncertain({ requestId: "unknown-harvest", category: "settlement-unknown", reason: "ws-timeout" });
    const requestLog = [];
    const ws = {
      async request(iface) {
        requestLog.push(iface);
        if (iface === "gs.usrLand.refresh") return { v: currentSync };
        if (iface === "gs.usr.heartTick" || iface === "gs.usr.lazySync") return { v: currentSync };
        throw new Error(`unexpected iface ${iface}`);
      },
    };

    await garden.runGardenCycle(ws, "token", currentSync, 1, {
      profileId: "main",
      experienceLevelGuard: guard,
      getExperienceGuardThresholdPercent: () => 1,
      moduleHealth: createAutomationModuleHealthRegistry(),
    });

    assert.equal(requestLog.includes("gs.usrLand.harvest"), false);
    const statusJson = JSON.parse(fs.readFileSync(path.join(outDir, "garden-status.json"), "utf8"));
    assert.equal(statusJson.summary.cycleErrorCount > 0, true);
    assert.equal(statusJson.summary.cycleErrors.some((entry) => (
      entry.category === "action-blocked"
      && entry.reason === "experience-guard-settlement-unresolved"
    )), true);
    assert.equal(statusJson.summary.moduleHealth.status, "degraded");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

function makeUpgradeLevelConfig() {
  return createFlowerLevelConfig({
    flowerLvlRows: [
      { id: -1, $lvlMax: 20 },
      { id: 23001, gldCost: 100 },
      { id: 23002, gldCost: 100 },
    ],
    flowerLvlCfgRows: [
      { id: 1, gldCost: 100, lvlUpCost: 1 },
      { id: 2, gldCost: 200, lvlUpCost: 2 },
      { id: 3, gldCost: 300, lvlUpCost: 3 },
    ],
    flowerRows: [
      { id: 23001, eliteId: 22001 },
      { id: 23002, eliteId: 22002 },
    ],
  });
}

function makeUpgradeSync(gld = 1000) {
  return {
    $usrTot: {
      data: {
        gld,
        bag: { 22001: 10, 22002: 10 },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 1 },
        23002: { flowerId: 23002, lvl: 2 },
      },
    },
  };
}

test("autoUpgradeFlowers requests upgrade for upgradable flowers in level order", async () => {
  const upgradeLog = [];
  const ws = {
    async request(iface, args, token) {
      if (iface === "gs.cultivate.upgrade") {
        upgradeLog.push({ args, token });
        return raw({});
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const { autoUpgradeFlowers } = await import(
    `./inspect-garden-dryrun.mjs?flower-upgrade-call=${Date.now()}`
  );
  const result = await autoUpgradeFlowers(ws, "test-token", makeUpgradeSync(), {
    cycle: 1,
    flowerLevelConfig: makeUpgradeLevelConfig(),
  });
  assert.deepEqual(upgradeLog.map((entry) => entry.args), [
    { flowerId: 23001 },
    { flowerId: 23002 },
  ]);
  assert.equal(upgradeLog.every((entry) => entry.token === "test-token"), true);
  assert.equal(result.upgradedCount, 2);
});

test("autoUpgradeFlowers skips when AUTO_HANDLE_FLOWER_UPGRADE is disabled", async () => {
  const oldEnv = { ...process.env };
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  process.env.AUTO_HANDLE_FLOWER_UPGRADE = "0";
  try {
    const ws = {
      async request() {
        throw new Error("unexpected request");
      },
    };
    const { autoUpgradeFlowers } = await import(
      `./inspect-garden-dryrun.mjs?flower-upgrade-skip=${Date.now()}`
    );
    const result = await autoUpgradeFlowers(ws, "test-token", makeUpgradeSync(), {
      cycle: 1,
      flowerLevelConfig: makeUpgradeLevelConfig(),
    });
    assert.equal(result.upgradedCount, 0);
    const parsedLogs = logs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const skip = parsedLogs.find((entry) => entry.step === "flowerUpgradeSkip");
    assert.equal(skip?.reason, "disabled");
  } finally {
    console.log = oldLog;
    process.env = oldEnv;
  }
});

test("autoUpgradeFlowers logs errMsg and continues with the next candidate", async () => {
  const oldLog = console.log;
  const logs = [];
  console.log = (line = "") => { logs.push(String(line)); };
  const upgradeLog = [];
  const ws = {
    async request(iface, args) {
      if (iface === "gs.cultivate.upgrade") {
        upgradeLog.push(args.flowerId);
        if (args.flowerId === 23001) return { m: "upgrade blocked" };
        return raw({ cultivateTot: { cultivateMap: { 23002: { lvl: 20 } } } });
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  try {
    const { autoUpgradeFlowers } = await import(
      `./inspect-garden-dryrun.mjs?flower-upgrade-errmsg=${Date.now()}`
    );
    const result = await autoUpgradeFlowers(ws, "test-token", makeUpgradeSync(), {
      cycle: 1,
      flowerLevelConfig: makeUpgradeLevelConfig(),
    });
    assert.deepEqual(upgradeLog, [23001, 23002]);
    assert.equal(result.upgradedCount, 1);
    const parsedLogs = logs.map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const errorEntry = parsedLogs.find((entry) => entry.step === "flowerUpgradeError");
    assert.equal(errorEntry?.flowerId, 23001);
    assert.equal(errorEntry?.err, "upgrade blocked");
  } finally {
    console.log = oldLog;
  }
});

test("autoUpgradeFlowers tries the same flower only once per cycle", async () => {
  const syncValue = {
    $usrTot: { data: { gld: 1000, bag: { 22001: 10 } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
  };
  let upgradeRequests = 0;
  const ws = {
    async request(iface) {
      if (iface === "gs.cultivate.upgrade") {
        upgradeRequests += 1;
        return raw({});
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const { autoUpgradeFlowers } = await import(
    `./inspect-garden-dryrun.mjs?flower-upgrade-once=${Date.now()}`
  );
  const result = await autoUpgradeFlowers(ws, "test-token", syncValue, {
    cycle: 1,
    flowerLevelConfig: makeUpgradeLevelConfig(),
  });
  assert.equal(upgradeRequests, 1);
  assert.equal(result.upgradedCount, 1);
});

test("autoUpgradeFlowers recomputes candidates after a successful upgrade", async () => {
  const upgradeLog = [];
  const ws = {
    async request(iface, args) {
      if (iface === "gs.cultivate.upgrade") {
        upgradeLog.push(args.flowerId);
        if (args.flowerId === 23001) {
          return raw({
            cultivateTot: { cultivateMap: { 23001: { lvl: 20 } } },
            $usrTot: { data: { gld: 900, bag: { 22001: 9 } } },
          });
        }
        return raw({
          cultivateTot: { cultivateMap: { 23002: { lvl: 20 } } },
          $usrTot: { data: { gld: 800, bag: { 22002: 9 } } },
        });
      }
      throw new Error(`unexpected iface ${iface}`);
    },
  };
  const { autoUpgradeFlowers } = await import(
    `./inspect-garden-dryrun.mjs?flower-upgrade-recompute=${Date.now()}`
  );
  const result = await autoUpgradeFlowers(ws, "test-token", makeUpgradeSync(), {
    cycle: 1,
    flowerLevelConfig: makeUpgradeLevelConfig(),
  });
  assert.deepEqual(upgradeLog, [23001, 23002]);
  assert.equal(result.upgradedCount, 2);
  assert.equal(result.syncValue.cultivateTot.cultivateMap["23001"].lvl, 20);
  assert.equal(result.syncValue.cultivateTot.cultivateMap["23002"].lvl, 20);
  assert.equal(result.syncValue.$usrTot.data.gld, 800);
});
