import test from "node:test";
import assert from "node:assert/strict";
import {
  createRunHistory,
  recordCustomerOrderCheck,
  recordCustomerOrderSubmission,
} from "./run-history.mjs";

test("run history records only entries appended after this script start", () => {
  const history = createRunHistory({ now: () => new Date("2026-06-16T02:00:00.000Z") });

  assert.equal(history.startedAtText, "2026-06-16 10:00:00");
  assert.deepEqual(history.customerOrderSubmissions, []);
  assert.deepEqual(history.customerOrderChecks, []);

  recordCustomerOrderCheck(history, {
    cycle: 6,
    customerStep: 1,
    customerStatus: {
      total: 0,
      readyCount: 0,
      makeArtReadyCount: 0,
      temporaryOutOfStockCount: 0,
      skippedCount: 0,
      doubleGoldGate: {
        ready: true,
        reasonText: "双倍金币有效",
        remainingText: "1小时00分00秒",
      },
      orders: [],
    },
    actions: [],
  }, { now: () => new Date("2026-06-16T02:00:30.000Z") });

  recordCustomerOrderSubmission(history, {
    cycle: 7,
    action: { npcId: 8, artId: 300101, reason: "customer-art-stock-ready" },
    order: {
      statusText: "可提交",
      artLabel: "花艺-300101",
      needArt: 1,
      haveArt: 2,
      flowerRequirements: [],
    },
  }, { now: () => new Date("2026-06-16T02:01:00.000Z") });

  recordCustomerOrderSubmission(history, {
    cycle: 7,
    action: {
      npcId: 9,
      artId: 300102,
      reason: "customer-temporary-out-of-stock-reject",
      steps: [
        {
          type: "rejectCustomerOrder",
          iface: "gs.orderCustomer.rejectOrder",
          args: { npcId: 9 },
        },
      ],
    },
    order: {
      statusText: "暂时没货",
      artLabel: "花艺-300102",
      needArt: 1,
      haveArt: 0,
      flowerRequirements: [
        { name: "明黄矮牵牛", have: 1, need: 2, missing: 1 },
      ],
    },
  }, { now: () => new Date("2026-06-16T02:01:30.000Z") });

  assert.equal(history.customerOrderSubmissions.length, 2);
  assert.equal(history.customerOrderChecks.length, 1);
  assert.equal(history.customerOrderChecks[0].index, 1);
  assert.equal(history.customerOrderChecks[0].timeText, "2026-06-16 10:00:30");
  assert.equal(history.customerOrderChecks[0].resultText, "暂无顾客订单");
  assert.equal(history.customerOrderChecks[0].doubleGoldReady, true);
  assert.equal(history.customerOrderSubmissions[0].index, 1);
  assert.equal(history.customerOrderSubmissions[0].timeText, "2026-06-16 10:01:00");
  assert.equal(history.customerOrderSubmissions[0].submittedAtText, "2026-06-16 10:01:00");
  assert.equal(history.customerOrderSubmissions[0].npcId, 8);
  assert.equal(history.customerOrderSubmissions[0].outcome, "completed");
  assert.equal(history.customerOrderSubmissions[0].outcomeText, "完成订单");
  assert.equal(history.customerOrderSubmissions[1].index, 2);
  assert.equal(history.customerOrderSubmissions[1].timeText, "2026-06-16 10:01:30");
  assert.equal(history.customerOrderSubmissions[1].npcId, 9);
  assert.equal(history.customerOrderSubmissions[1].outcome, "temporary-out-of-stock");
  assert.equal(history.customerOrderSubmissions[1].outcomeText, "暂时没货：按官方按钮拒绝顾客订单");
  assert.equal(Object.hasOwn(history, "cyclicStorySubmissions"), false);
});
