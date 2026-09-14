import test from "node:test";
import assert from "node:assert/strict";

import {
  MAIN_TASK_IFACES,
  RESIDENT_ORDER_MAIN_TASK_TYPE,
  RESIDENT_ORDER_MAIN_TASK_TYPES,
  getAutoSubmitMainTaskActions,
  isResidentOrderMainTaskStatus,
  summarizeMainTaskStatus,
} from "./main-task-state.mjs";

const mainTaskConfig = {
  endId: 99,
  tasks: new Map([
    [10, { id: 10, index: 10, desc: "完成一次种植", value: 3, rewards: [[11, 100]] }],
    [11, { id: 11, index: 11, desc: "完成一次浇水", value: 1, rewards: [[11, 120]] }],
    [12, { id: 12, index: 12, type: RESIDENT_ORDER_MAIN_TASK_TYPE, desc: "完成72次居民订单", value: 72, rewards: [[11, 120]] }],
    [13, { id: 13, index: 13, type: 2001, desc: "完成一次其他任务", value: 5, rewards: [[11, 120]] }],
    [14, { id: 14, index: 14, type: 3006, desc: "完成3次居民订单", value: 3, rewards: [[11, 120]] }],
    [15, { id: 15, index: 15, type: 2, desc: "level up to 10", value: 10, rewards: [[11, 120]] }],
  ]),
};

test("summarizeMainTaskStatus marks completed current main task as receivable", () => {
  const status = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 10,
        curValue: 3,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(status.exists, true);
  assert.equal(status.status, "ready");
  assert.equal(status.canReceive, true);
  assert.equal(status.taskId, 10);
  assert.equal(status.curValue, 3);
  assert.equal(status.targetValue, 3);
  assert.equal(status.progressText, "3/3");
  assert.deepEqual(getAutoSubmitMainTaskActions(status), [
    {
      kind: "mainTask",
      iface: MAIN_TASK_IFACES.recv,
      args: {},
      reason: "main-task-progress-ready",
      taskId: 10,
      curValue: 3,
      targetValue: 3,
    },
  ]);
});

test("summarizeMainTaskStatus prefers a later main task source with current task id over an earlier partial source", () => {
  const status = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curValue: 3,
        recvMap: {},
      },
      taskCtrl_main: {
        curTaskId: 10,
        curValue: 3,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(status.exists, true);
  assert.equal(status.status, "ready");
  assert.equal(status.canReceive, true);
  assert.equal(status.taskId, 10);
  assert.equal(status.curValue, 3);
  assert.equal(status.sourcePath, "taskTot.taskCtrl_main");
});

test("summarizeMainTaskStatus skips unfinished or already received main tasks", () => {
  const unfinished = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 10,
        curValue: 2,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(unfinished.status, "in-progress");
  assert.equal(unfinished.canReceive, false);
  assert.deepEqual(getAutoSubmitMainTaskActions(unfinished), []);

  const received = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 10,
        curValue: 3,
        recvMap: { 10: 1 },
      },
    },
  }, { mainTaskConfig });

  assert.equal(received.status, "received");
  assert.equal(received.canReceive, false);
  assert.deepEqual(getAutoSubmitMainTaskActions(received), []);
});

test("summarizeMainTaskStatus exposes resident order task type and remaining progress", () => {
  const status = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 12,
        curValue: 70,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(status.taskType, RESIDENT_ORDER_MAIN_TASK_TYPE);
  assert.equal(status.isResidentOrderMainTask, true);
  assert.equal(status.canProgressResidentOrderMainTask, true);
  assert.equal(status.remainingValue, 2);
  assert.equal(isResidentOrderMainTaskStatus(status), true);
});

test("resident order main task gate closes for other tasks, completed tasks, and received tasks", () => {
  const otherTask = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 13,
        curValue: 1,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(otherTask.taskType, 2001);
  assert.equal(otherTask.isResidentOrderMainTask, false);
  assert.equal(otherTask.canProgressResidentOrderMainTask, false);
  assert.equal(isResidentOrderMainTaskStatus(otherTask), false);

  const completed = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 12,
        curValue: 72,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(completed.isResidentOrderMainTask, true);
  assert.equal(completed.canProgressResidentOrderMainTask, false);
  assert.equal(completed.remainingValue, 0);
  assert.equal(isResidentOrderMainTaskStatus(completed), false);

  const received = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 12,
        curValue: 72,
        recvMap: { 12: 1 },
      },
    },
  }, { mainTaskConfig });

  assert.equal(received.isResidentOrderMainTask, true);
  assert.equal(received.canProgressResidentOrderMainTask, false);
  assert.equal(isResidentOrderMainTaskStatus(received), false);
});

test("resident order main task detection includes multi-count resident order task type 3006", () => {
  assert.equal(RESIDENT_ORDER_MAIN_TASK_TYPES.has(3006), true);

  const status = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 14,
        curValue: 1,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(status.taskType, 3006);
  assert.equal(status.isResidentOrderMainTask, true);
  assert.equal(status.canProgressResidentOrderMainTask, true);
  assert.equal(status.remainingValue, 2);
});

test("level-up main task allows ordinary resident order submission while unfinished", () => {
  const status = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 15,
        curValue: 9,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(status.taskType, 2);
  assert.equal(status.isResidentOrderMainTask, false);
  assert.equal(status.canProgressResidentOrderMainTask, false);
  assert.equal(status.isLevelUpMainTask, true);
  assert.equal(status.canProgressLevelUpMainTask, true);
  assert.equal(status.canSubmitOrdinaryResidentOrderForMainTask, true);
  assert.equal(status.ordinaryResidentOrderGateReason, "level-up-main-task");
});

test("level-up main task gate closes when completed or received", () => {
  const completed = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 15,
        curValue: 10,
        recvMap: {},
      },
    },
  }, { mainTaskConfig });

  assert.equal(completed.isLevelUpMainTask, true);
  assert.equal(completed.canProgressLevelUpMainTask, false);
  assert.equal(completed.canSubmitOrdinaryResidentOrderForMainTask, false);
  assert.equal(completed.ordinaryResidentOrderGateReason, null);

  const received = summarizeMainTaskStatus({
    taskTot: {
      main: {
        curTaskId: 15,
        curValue: 10,
        recvMap: { 15: 1 },
      },
    },
  }, { mainTaskConfig });

  assert.equal(received.isLevelUpMainTask, true);
  assert.equal(received.canProgressLevelUpMainTask, false);
  assert.equal(received.canSubmitOrdinaryResidentOrderForMainTask, false);
  assert.equal(received.ordinaryResidentOrderGateReason, null);
});
