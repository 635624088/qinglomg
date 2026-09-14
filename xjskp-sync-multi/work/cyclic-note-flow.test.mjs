import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  autoHandleCyclicNote,
  getCyclicNoteOrdinaryResidentAutoSubmitSetting,
} from "./inspect-garden-dryrun.mjs";
import { loadPearlConfig } from "./pearl-state.mjs";

const NOW_MS = Date.now();
const CONFIG = {
  actCyclicNote: {
    1001: { id: 1001, type: 3002, value: 3, reward: [[1107, 1]] },
    1005: { id: 1005, type: 3014, value: 65, reward: [[1107, 5]] },
    1007: { id: 1007, type: 3016, value: 5, reward: [[1107, 3]] },
    1009: { id: 1009, type: 9999, value: 5, reward: [[1107, 9]] },
    1010: { id: 1010, type: 1010, value: 1, reward: [[1107, 10]] },
  },
  taskType: {},
};

function makeSync(batchId, progress, recvMap = {}, taskList = [1001, 1005, 1007]) {
  return {
    $timeAuthority: {
      version: 1,
      lastAcceptedSample: {
        serverMs: NOW_MS,
        correctedServerMs: NOW_MS,
        requestStartedAtMs: NOW_MS,
        responseAtMs: NOW_MS,
        rttMs: 0,
        serverOffsetMs: 0,
        acceptedAtMs: NOW_MS,
      },
      sampleMaxAgeMs: 120_000,
    },
    actTot: {
      map: {
        [batchId]: {
          tmpId: 4002,
          tmpType: 4002,
          batchId,
          bms: NOW_MS - 60_000,
          ems: NOW_MS + 60_000,
          duration_before: 0,
          duration_after: 0,
          ext: { cyclicNote: { taskList } },
        },
      },
      taskRcdMap: {
        [`${batchId}|0`]: { progress, recvMap },
      },
    },
  };
}

function options(extra = {}) {
  return {
    actionTime: {
      nowMs: NOW_MS,
      timeTrusted: true,
      clockSource: "test",
      timeAuthorityReason: null,
    },
    cyclicNoteConfig: CONFIG,
    itemNameMap: { 1107: "集芳笺" },
    ...extra,
  };
}

function withEnabledSetting() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyclic-note-flow-"));
  const settingsPath = path.join(dir, "profile-settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    autoHandleCyclicNote: true,
    autoCompleteCyclicNoteHighestRewardTask: true,
  }), "utf8");
  return { dir, oldEnv: { ...process.env }, settingsPath };
}

test("cyclic-note resident orders bypass only the profile switch", () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    delete process.env.AUTO_SUBMIT_SPECIAL_ORDERS;
    delete process.env.AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS;
    delete process.env.ORDINARY_RESIDENT_ORDER_SINGLE_SAMPLE;

    const setting = getCyclicNoteOrdinaryResidentAutoSubmitSetting();
    assert.equal(setting.ordinaryAutoSubmitEnabled, true);
    assert.equal(setting.source, "cyclic-note-natural-target");
    assert.equal(setting.bypassSpecialOrderDailyLimit, false);

    Object.assign(process.env, {
      ACTION: "auto-loop",
      MAX_CYCLES: "1",
      ORDINARY_RESIDENT_ORDER_SINGLE_SAMPLE: "1",
      ORDINARY_RESIDENT_ORDER_MAX_STEPS_PER_CYCLE: "1",
      AUTO_SUBMIT_ORDINARY_RESIDENT_ORDERS: "1",
      AUTO_SUBMIT_SPECIAL_ORDERS: "0",
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
    const validationSetting = getCyclicNoteOrdinaryResidentAutoSubmitSetting();
    assert.equal(validationSetting.ordinaryAutoSubmitEnabled, true);
    assert.equal(validationSetting.bypassSpecialOrderDailyLimit, false);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("cyclic-note routes preserve full flower-rack and 16-land natural batches", () => {
  const source = fs.readFileSync(new URL("./inspect-garden-dryrun.mjs", import.meta.url), "utf8");
  const routeHandler = source.slice(
    source.indexOf("async function runCyclicNoteTaskHandler"),
    source.indexOf("async function autoHandleCyclicNote"),
  );
  const flowerRackHandler = source.slice(
    source.indexOf("export async function autoHandleFlowerRack"),
    source.indexOf("const MAX_MATERIAL_SHOP_REFRESH_ATTEMPTS_PER_CYCLE"),
  );

  assert.match(source, /const PLANT_LAND_GROUP_SIZE = 16;/);
  assert.match(routeHandler, /maxPlantCount: candidate\.emptyLandIds\.length/);
  assert.doesNotMatch(routeHandler, /maxActions|maxHarvestCount|maxWaterCount/);
  assert.doesNotMatch(routeHandler, /emptyLandIds\.length <= remainingProgress|seededLandIds\.length > remainingProgress/);
  assert.match(flowerRackHandler, /const plannedActions = status\.actions;/);
  assert.doesNotMatch(flowerRackHandler, /cyclicNoteTargetOnly\s*\?/);
});

test("cyclic-note pearl hire fills every executable free slot despite the normal reserve", async () => {
  const isolation = withEnabledSetting();
  try {
    fs.writeFileSync(isolation.settingsPath, JSON.stringify({
      autoHandleCyclicNote: true,
      autoCompleteCyclicNoteHighestRewardTask: true,
      pearlHireItemReserveCount: 100,
    }), "utf8");
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    process.env.AUTO_HANDLE_CYCLIC_NOTE = "1";
    process.env.AUTO_HANDLE_PEARL = "1";
    process.env.PEARL_CHECK_HIRE_STATE = "0";

    const pearlConfig = loadPearlConfig();
    const placeIds = Object.keys(pearlConfig.places).slice(0, 3).map(Number);
    const hireItemId = pearlConfig.hireItemId;
    const sync = makeSync(329, { 1010: 0, 1001: 0, 1007: 0 }, {}, [1010, 1001, 1007]);
    sync.$usrTot = { data: { bag: { [hireItemId]: 3 } } };
    sync.pearlTot = {
      pearl: { recvDailyDate: new Date(NOW_MS).toISOString() },
      placeMap: Object.fromEntries(placeIds.map((placeId) => [placeId, {
          placeId,
          everyMakeNum: 0,
          recvCnt: 0,
          surplusRecvNum: 0,
          eventId: 0,
        }])),
      recommendUserMap: {
        7001: { uid: 7001, nickname: "活动雇员" },
        7002: { uid: 7002, nickname: "活动雇员二" },
        7003: { uid: 7003, nickname: "活动雇员三" },
      },
      recommendList: [7001, 7002, 7003],
      otherHireMap: {},
    };
    const requests = [];
    await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        if (iface === "gs.actCyclicNote.enter") return { v: sync };
        if (iface === "gs.pearlPlace.hire") {
          const placeId = Number(args.placeId);
          const dstUid = Number(args.dstUid);
          return {
            v: {
              pearlTot: {
                placeMap: {
                  [placeId]: {
                    placeId,
                    laborUid: dstUid,
                    laborEndTime: new Date(NOW_MS + 60_000).toISOString(),
                    everyMakeNum: 1,
                    recvCnt: 0,
                    surplusRecvNum: 1,
                    eventId: 1,
                  },
                },
              },
            },
          };
        }
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 1, options());

    const hires = requests.filter(({ iface }) => iface === "gs.pearlPlace.hire");
    assert.equal(hires.length, 3);
    assert.deepEqual(hires.map(({ args }) => Number(args.placeId)).sort((a, b) => a - b), [...placeIds].sort((a, b) => a - b));
    assert.deepEqual(hires.map(({ args }) => Number(args.dstUid)).sort((a, b) => a - b), [7001, 7002, 7003]);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("disabled cyclic-note parent never enters or receives, even when the child strategy remains saved", async () => {
  const isolation = withEnabledSetting();
  try {
    fs.writeFileSync(isolation.settingsPath, JSON.stringify({
      autoHandleCyclicNote: false,
      autoCompleteCyclicNoteHighestRewardTask: true,
    }), "utf8");
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    process.env.AUTO_HANDLE_CYCLIC_NOTE = "1";
    const sync = makeSync(329, { 1001: 0, 1005: 65, 1007: 4 });
    const requests = [];
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 1, options());
    assert.deepEqual(requests, []);
    assert.equal(result.actionCount, 0);
    assert.equal(result.receivedCount, 0);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("AUTO_HANDLE_CYCLIC_NOTE=0 remains a hard stop when the parent is enabled", async () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    process.env.AUTO_HANDLE_CYCLIC_NOTE = "0";
    const sync = makeSync(329, { 1001: 0, 1005: 65, 1007: 4 });
    const requests = [];
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 1, options());
    assert.deepEqual(requests, []);
    assert.equal(result.actionCount, 0);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("all-task strategy falls through a blocked candidate to the next supported task", async () => {
  const isolation = withEnabledSetting();
  try {
    fs.writeFileSync(isolation.settingsPath, JSON.stringify({
      autoHandleCyclicNote: true,
      autoCompleteCyclicNoteHighestRewardTask: false,
    }), "utf8");
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    process.env.AUTO_HANDLE_CYCLIC_NOTE = "1";
    const sync = makeSync(329, { 1001: 0, 1005: 4, 1007: 0 });
    const attempted = [];
    const result = await autoHandleCyclicNote({
      async request(iface) {
        if (iface === "gs.actCyclicNote.enter") return { v: sync };
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 1, options({
      cyclicNoteTaskHandler: async ({ target }) => {
        attempted.push(target.taskId);
        return target.taskId === 1001
          ? { syncValue: sync, actionCount: 0, reason: "resource-blocked" }
          : { syncValue: sync, actionCount: 1, actions: [{ taskId: target.taskId }] };
      },
    }));
    assert.deepEqual(attempted, [1001, 1005]);
    assert.equal(result.actionCount, 1);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("successful receive is closed only after the authoritative enter confirms recvMap", async () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    const before = makeSync(329, { 1001: 0, 1005: 65, 1007: 4 });
    const receivedResponse = {
      actTot: {
        map: {
          329: {
            score: 11,
            ext: { cyclicNote: { taskList: [1001, 1009, 1007] } },
          },
        },
        taskRcdMap: {
          "329|0": {
            progress: { 1001: 0, 1009: 0, 1007: 4 },
            recvMap: { 1005: 1 },
          },
        },
      },
    };
    const confirmed = makeSync(329, { 1001: 0, 1005: 65, 1007: 4 }, { 1005: 1 });
    confirmed.actTot.map[329].score = 11;
    const requests = [];
    let enterCount = 0;
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        if (iface === "gs.actCyclicNote.enter") return { v: enterCount++ === 0 ? before : confirmed };
        if (iface === "gs.actCyclicNote.recvTaskRwd") return { v: receivedResponse };
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", before, 1, options());

    assert.deepEqual(requests, [
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
      { iface: "gs.actCyclicNote.recvTaskRwd", args: { batchId: 329, taskId: 1005 } },
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
    ]);
    assert.equal(result.receivedCount, 1);
    assert.equal(result.failedCount, 0);
    assert.deepEqual(result.actions.map((action) => action.taskId), [1005]);
    assert.equal(result.syncValue.actTot.map[329].score, 11);
    assert.equal(result.status.taskSlots.find((slot) => slot.taskId === 1005)?.received, true);
    assert.deepEqual(result.syncValue.actTot.taskRcdMap["329|0"].progress, {
      1001: 0,
      1005: 65,
      1007: 4,
    });
    assert.equal(result.syncValue.actTot.map[329].bms, before.actTot.map[329].bms);
    assert.equal(result.syncValue.actTot.map[329].ems, before.actTot.map[329].ems);
    assert.deepEqual(result.syncValue.$timeAuthority, before.$timeAuthority);
    assert.equal(requests.some(({ iface }) => /direct|refresh|unlock|gift|shop/i.test(iface)), false);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("unconfirmed receive is not resent during the same cyclic-note round", async () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    const sync = makeSync(329, { 1001: 0, 1005: 65, 1007: 4 });
    const requests = [];
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        if (iface === "gs.actCyclicNote.enter") return { v: sync };
        if (iface === "gs.actCyclicNote.recvTaskRwd") return { v: {} };
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 1, options());

    assert.equal(requests.filter(({ iface }) => iface === "gs.actCyclicNote.recvTaskRwd").length, 1);
    assert.equal(result.receivedCount, 0);
    assert.equal(result.failedCount, 1);
    assert.equal(result.failedActions[0]?.reason, "recv-task-rwd-unconfirmed");
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("no cyclic note action still returns the latest partial enter sync", async () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    const baseline = makeSync(329, { 1001: 2, 1005: 64, 1007: 4 }, {
      1001: 0,
      1005: 0,
      1007: 0,
    });
    const partialEnter = {
      actTot: {
        map: { 329: { score: 13 } },
        taskRcdMap: {
          "329|0": {
            progress: { 1001: 3, 1005: 65, 1007: 5 },
            recvMap: { 1001: 0, 1005: 0, 1007: 0 },
          },
        },
      },
    };
    const requests = [];
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        if (iface === "gs.actCyclicNote.enter") return { v: partialEnter };
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", baseline, 1, options());

    assert.deepEqual(requests, [
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
    ]);
    assert.equal(result.actionCount, 0);
    assert.equal(result.receivedCount, 0);
    assert.notEqual(result.syncValue, baseline);
    assert.equal(result.syncValue.actTot.map[329].score, 13);
    assert.deepEqual(result.syncValue.actTot.taskRcdMap["329|0"].progress, {
      1001: 3,
      1005: 65,
      1007: 5,
    });
    assert.deepEqual(result.syncValue.actTot.taskRcdMap["329|0"].recvMap, {
      1001: 0,
      1005: 0,
      1007: 0,
    });
    assert.equal(result.syncValue.actTot.map[329].bms, baseline.actTot.map[329].bms);
    assert.equal(result.syncValue.actTot.map[329].ems, baseline.actTot.map[329].ems);
    assert.deepEqual(result.syncValue.$timeAuthority, baseline.$timeAuthority);
    assert.equal(result.status.timeTrusted, true);
    assert.equal(result.status.clockSource, "server-heartbeat-corrected");
    assert.equal(result.status.timeAuthorityReason, null);
    assert.equal(result.status.taskSlots.length, 3);
    assert.deepEqual(result.status.taskSlots.map(({ taskId, current }) => ({ taskId, current })), [
      { taskId: 1001, current: 3 },
      { taskId: 1005, current: 65 },
      { taskId: 1007, current: 5 },
    ]);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("without a completed slot, only the highest reward route handler is called once", async () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    const sync = makeSync(329, { 1001: 0, 1005: 4, 1007: 0 });
    const requests = [];
    let enters = 0;
    let handlerCalls = 0;
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        if (iface === "gs.actCyclicNote.enter") return { v: sync };
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 2, options({
      cyclicNoteTaskHandler: async ({ target }) => {
        handlerCalls += 1;
        assert.equal(target.taskId, 1005);
        assert.equal(target.route, "water");
        return { syncValue: sync, actionCount: 1, actions: [{ taskId: target.taskId }] };
      },
    }));

    assert.equal(handlerCalls, 1);
    assert.equal(result.actionCount, 1);
    assert.deepEqual(requests, [
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
    ]);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});

test("highest unsupported reward delegates to the next highest supported route handler", async () => {
  const isolation = withEnabledSetting();
  try {
    process.env.PROFILE_SETTINGS_PATH = isolation.settingsPath;
    const sync = makeSync(
      329,
      { 1009: 0, 1005: 4, 1007: 0 },
      {},
      [1009, 1005, 1007],
    );
    const requests = [];
    let handlerCalls = 0;
    const result = await autoHandleCyclicNote({
      async request(iface, args) {
        requests.push({ iface, args });
        if (iface === "gs.actCyclicNote.enter") return { v: sync };
        throw new Error(`unexpected request ${iface}`);
      },
    }, "token", sync, 3, options({
      cyclicNoteTaskHandler: async ({ target }) => {
        handlerCalls += 1;
        assert.equal(target.taskId, 1005);
        assert.equal(target.route, "water");
        return { syncValue: sync, actionCount: 1, actions: [{ taskId: target.taskId }] };
      },
    }));

    assert.equal(handlerCalls, 1);
    assert.equal(result.actionCount, 1);
    assert.deepEqual(requests, [
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
      { iface: "gs.actCyclicNote.enter", args: { batchId: 329 } },
    ]);
    assert.equal(requests.some(({ iface }) => iface === "gs.actCyclicNote.recvTaskRwd"), false);
    assert.equal(requests.some(({ iface }) => /direct|refresh|unlock|gift|box|shop/i.test(iface)), false);
  } finally {
    process.env = isolation.oldEnv;
    fs.rmSync(isolation.dir, { recursive: true, force: true });
  }
});
