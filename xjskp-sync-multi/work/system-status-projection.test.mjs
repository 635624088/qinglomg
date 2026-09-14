import test from "node:test";
import assert from "node:assert/strict";

import { buildProfileStatusProjection } from "./system/status-projection.mjs";

test("buildProfileStatusProjection keeps dashboard fields without copying heavy raw collections", () => {
  const garden = {
    summary: {
      doubleGoldRemainingText: "9分50秒",
      waterDropNeedText: "还需 8",
      accountLevel: { level: 40 },
      automationStopped: null,
      unrelatedLargeField: ["do-not-copy"],
    },
    waterwheel: { status: "ready" },
    flowerRack: {
      recommendedArts: [
        { artId: 305101, label: "305101(青瓷瓶+红玫瑰)", salePrice: 200 },
      ],
    },
    specialOrders: { satin: { completedCount: 2 } },
    ordinaryResidentOrders: { total: 6, orders: [{ orderId: 1 }] },
    cyclicStory: { active: true },
    cyclicNote: { active: true, taskSlots: [{ taskId: 1 }] },
    mainTaskStatus: { status: "doing" },
    mainTasks: { current: { progressText: "2/5" } },
    accountLevel: { level: 40 },
    experienceGuard: { blocked: false },
    inventorySorted: Array.from({ length: 500 }, (_, index) => ({ index })),
    runHistory: Array.from({ length: 500 }, (_, index) => ({ index })),
    moduleHealth: { modules: { flowerUpgrade: { history: Array(500).fill("large") } } },
  };
  const order = {
    residentBoard: { completedCount: 425, accountHistoricalMaxTeamExp: 1234 },
    ordinary: { rows: Array.from({ length: 500 }, (_, index) => ({ index })) },
    runHistory: Array.from({ length: 500 }, (_, index) => ({ index })),
  };

  const projection = buildProfileStatusProjection({
    gardenStatus: { ok: true, data: garden },
    orderStatus: { ok: true, data: order },
  });

  assert.deepEqual(projection.garden.summary, {
    doubleGoldRemainingText: "9分50秒",
    waterDropNeedText: "还需 8",
    accountLevel: { level: 40 },
    automationStopped: null,
    experienceGuard: null,
  });
  assert.deepEqual(projection.garden.waterwheel, garden.waterwheel);
  assert.deepEqual(projection.garden.flowerRack, garden.flowerRack);
  assert.deepEqual(projection.garden.ordinaryResidentOrders, garden.ordinaryResidentOrders);
  assert.deepEqual(projection.order.residentBoard, order.residentBoard);
  assert.equal(Object.hasOwn(projection.garden, "inventorySorted"), false);
  assert.equal(Object.hasOwn(projection.garden, "runHistory"), false);
  assert.equal(Object.hasOwn(projection.garden, "moduleHealth"), false);
  assert.equal(Object.hasOwn(projection.order, "ordinary"), false);
  assert.equal(JSON.stringify(projection).length < JSON.stringify({ garden, order }).length / 10, true);
});

test("buildProfileStatusProjection returns stable empty containers for missing artifacts", () => {
  assert.deepEqual(buildProfileStatusProjection({
    gardenStatus: { ok: false, errorType: "not-found" },
    orderStatus: { ok: false, errorType: "not-found" },
  }), {
    garden: null,
    order: null,
  });
});
