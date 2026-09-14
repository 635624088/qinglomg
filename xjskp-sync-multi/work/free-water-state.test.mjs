import assert from "node:assert/strict";
import test from "node:test";

import { FREE_WATER_IFACES, summarizeFreeWaterStatus } from "./free-water-state.mjs";
import { ITEM_IDS } from "./garden-state.mjs";

const FREE_WATER_CONFIG = {
  timePeriods: [[11, 14], [17, 21]],
  itemId: ITEM_IDS.WATER_DROP,
  receiveWaterDropCount: 30,
  patchCost: [1, 5],
};

function makeSync(waterDropCount, freeWater) {
  return {
    $usrTot: {
      data: {
        bag: {
          [ITEM_IDS.WATER_DROP]: waterDropCount,
        },
      },
    },
    freeWater,
  };
}

test("summarizeFreeWaterStatus plans current slot when water is below threshold", () => {
  const nowMs = new Date(2026, 5, 16, 11, 30, 0).getTime();
  const status = summarizeFreeWaterStatus(
    makeSync(12, { recvIdx: [], rTime: new Date(nowMs).toISOString() }),
    { nowMs, freeWaterConfig: FREE_WATER_CONFIG },
  );

  assert.equal(status.canReceive, true);
  assert.equal(status.nextReceiveIdx, 0);
  assert.equal(status.receiveWaterDropCount, 30);
  assert.deepEqual(status.pendingActions, [
    {
      type: "recvFreeWater",
      iface: FREE_WATER_IFACES.recv,
      idx: 0,
      args: { idx: 0 },
      receiveNo: 1,
      expectedItemId: ITEM_IDS.WATER_DROP,
      expectedWaterDropCount: 30,
    },
  ]);
});

test("summarizeFreeWaterStatus does not plan receive when water is not below threshold", () => {
  const nowMs = new Date(2026, 5, 16, 11, 30, 0).getTime();
  const status = summarizeFreeWaterStatus(
    makeSync(16, { recvIdx: [], rTime: new Date(nowMs).toISOString() }),
    { nowMs, freeWaterConfig: FREE_WATER_CONFIG },
  );

  assert.equal(status.canReceive, false);
  assert.equal(status.pendingActions.length, 0);
  assert.match(status.reasonText, /16 >= 16/);
});

test("summarizeFreeWaterStatus resets received slots when freeWater rTime is stale", () => {
  const nowMs = new Date(2026, 5, 16, 17, 30, 0).getTime();
  const yesterdayMs = new Date(2026, 5, 15, 17, 30, 0).getTime();
  const status = summarizeFreeWaterStatus(
    makeSync(8, { recvIdx: [1], rTime: new Date(yesterdayMs).toISOString() }),
    { nowMs, freeWaterConfig: FREE_WATER_CONFIG },
  );

  assert.deepEqual(status.recvIdx, []);
  assert.equal(status.canReceive, true);
  assert.equal(status.nextReceiveIdx, 1);
});
