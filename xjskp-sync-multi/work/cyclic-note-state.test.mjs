import assert from "node:assert/strict";
import test from "node:test";

import {
  CYCLIC_NOTE_IFACES,
  CYCLIC_NOTE_MAX_TASK_SLOTS,
  summarizeCyclicNoteStatus,
} from "./cyclic-note-state.mjs";
import { createTimeAuthority } from "./time-authority.mjs";

const NOW_MS = Date.parse("2026-09-01T12:00:00.000Z");
const CONFIG = {
  actCyclicNote: {
    1001: { id: 1001, type: 1009, value: 3, color: 1, reward: [[1107, 1]] },
    1002: { id: 1002, type: 1010, value: 65, color: 2, reward: [[1107, 2]] },
    1003: { id: 1003, type: 3014, value: 5, color: 3, reward: [[1107, 3]] },
  },
  taskType: {},
};

function makeSync({
  taskList = [1001, 1002, 1003],
  progress,
  recvMap = {},
  authority = "complete",
  phase = 2,
  batchId = 329,
  tmpId = 40020008,
  score = 35,
  boxes = [[1, 10], [2, 40], [3, 80]],
} = {}) {
  const act = {
    tmpId,
    tmpType: 4002,
    batchId,
    phase,
    bms: NOW_MS - 1_000,
    ems: NOW_MS + 60_000,
    duration_before: 0,
    duration_after: 0,
    score,
    ext: { cyclicNote: { taskList } },
  };
  const sync = {
    actTot: {
      map: { [batchId]: act },
      ...(boxes ? { tmpMap: { [tmpId]: { boxes } } } : {}),
    },
  };
  if (authority !== "missing-map") {
    sync.actTot.taskRcdMap = {};
    if (authority !== "missing-record") {
      sync.actTot.taskRcdMap[`${batchId}|0`] = {};
      if (authority !== "missing-progress") {
        sync.actTot.taskRcdMap[`${batchId}|0`].progress = progress ?? { 1001: 0, 1002: 0, 1003: 0 };
      }
      if (authority !== "missing-recv-map") {
        sync.actTot.taskRcdMap[`${batchId}|0`].recvMap = recvMap;
      }
    }
  }
  return sync;
}

function summarize(sync) {
  return summarizeCyclicNoteStatus(sync, {
    cyclicNoteConfig: CONFIG,
    itemNameMap: { 1107: "集芳笺" },
    nowMs: NOW_MS,
    timeTrusted: true,
  });
}

test("active status exposes phase remaining and exactly three authoritative slots", () => {
  const status = summarize(makeSync());
  assert.equal(status.active, true);
  assert.equal(status.phase, 2);
  assert.equal(status.phaseRemainingMs, 60_000);
  assert.equal(status.taskSlots.length, CYCLIC_NOTE_MAX_TASK_SLOTS);
  assert.equal(status.executionSafe, true);
});

test("cyclic-note score progress uses the last official activity reward-box target as its upper limit", () => {
  const status = summarize(makeSync({
    score: 35,
    boxes: [[7001, 10], [7002, 40], [7003, 80]],
  }));

  assert.equal(status.score, 35);
  assert.equal(status.scoreLimit, 80);
  assert.equal(status.scoreLimitSourcePath, 'actTot.tmpMap["40020008"].boxes[2][1]');
});

test("cyclic-note score upper limit stays unknown when the official activity template is absent", () => {
  const status = summarize(makeSync({ boxes: null }));

  assert.equal(status.score, 35);
  assert.equal(status.scoreLimit, null);
  assert.equal(status.scoreLimitSourcePath, null);
});

test("a fresh server-validated local time snapshot makes an authoritative active status executable", () => {
  const authority = createTimeAuthority({ maxAgeMs: 10_000 });
  authority.beginHeartbeat(NOW_MS - 45);
  const timeSnapshot = authority.recordHeartbeat({
    responseAtMs: NOW_MS,
    serverMs: NOW_MS + 99.5 - (45 / 2),
  });
  const status = summarizeCyclicNoteStatus(makeSync({
    progress: { 1001: 3, 1002: 65, 1003: 5 },
  }), {
    cyclicNoteConfig: CONFIG,
    itemNameMap: { 1107: "集芳笺" },
    nowMs: timeSnapshot.correctedNowMs,
    timeTrusted: timeSnapshot.trusted,
    clockSource: timeSnapshot.clockSource,
  });

  assert.equal(timeSnapshot.trusted, true);
  assert.equal(status.timeTrusted, true);
  assert.equal(status.taskSlots.length, CYCLIC_NOTE_MAX_TASK_SLOTS);
  assert.equal(status.executionSafe, true);
  assert.equal(status.phaseRemainingMs, 60_000);
});

test("missing progress keys are zero and completed slots produce normal receive actions", () => {
  const status = summarize(makeSync({ progress: { 1002: 65 } }));
  assert.deepEqual(status.taskSlots.map((slot) => slot.current), [0, 65, 0]);
  assert.deepEqual(status.pendingReceiveActions.map((action) => action.taskId), [1002]);
  assert.deepEqual(status.pendingReceiveActions[0].args, { batchId: 329, taskId: 1002 });
  assert.equal(status.pendingReceiveActions[0].iface, CYCLIC_NOTE_IFACES.recvTaskRwd);
});

test("recvMap uses authoritative present and non-null entries, including zero", () => {
  for (const recvMap of [{ 1001: 0 }, new Map([[1001, 0]])]) {
    const status = summarize(makeSync({ progress: { 1001: 3, 1002: 0, 1003: 0 }, recvMap }));
    assert.equal(status.taskSlots[0].status, "received");
    assert.equal(status.taskSlots[0].received, true);
    assert.deepEqual(status.pendingReceiveActions, []);
  }

  for (const recvMap of [{ 1001: null }, { 1001: undefined }, new Map([[1001, null]]), new Map([[1001, undefined]])]) {
    const status = summarize(makeSync({ progress: { 1001: 3, 1002: 0, 1003: 0 }, recvMap }));
    assert.equal(status.taskSlots[0].received, false);
    assert.deepEqual(status.pendingReceiveActions.map((action) => action.taskId), [1001]);
  }
});

test("missing authoritative map, record, progress, or recvMap closes automation and shows waiting data", () => {
  for (const authority of ["missing-map", "missing-record", "missing-progress", "missing-recv-map"]) {
    const status = summarize(makeSync({ authority }));
    assert.equal(status.executionSafe, false, authority);
    assert.equal(status.pendingReceiveActions.length, 0, authority);
    assert.equal(status.reasonText, "等待官方数据", authority);
  }

  const legacyOnly = makeSync({ authority: "missing-map", progress: { 1001: 3 } });
  legacyOnly.actTot.map[329].ext.cyclicNote.progress = { 1001: 3 };
  legacyOnly.actTot.map[329].ext.cyclicNote.recvMap = {};
  const status = summarize(legacyOnly);
  assert.equal(status.taskSlots[0].current, null);
  assert.deepEqual(status.pendingReceiveActions, []);
});

test("invalid raw progress types close automation instead of coercing them", () => {
  const status = summarize(makeSync({ progress: { 1001: "3", 1002: 0, 1003: 0 } }));
  assert.equal(status.taskSlots[0].current, null);
  assert.equal(status.executionSafe, false);
  assert.equal(status.snapshotError, "invalid-task-slot");
  assert.deepEqual(status.pendingReceiveActions, []);
});

test("non-three-slot authoritative task lists close automation", () => {
  const status = summarize(makeSync({ taskList: [1001, 1002] }));
  assert.equal(status.taskSlots.length, 2);
  assert.equal(status.executionSafe, false);
  assert.equal(status.snapshotError, "invalid-task-slot-count");
  assert.deepEqual(status.pendingReceiveActions, []);
});
