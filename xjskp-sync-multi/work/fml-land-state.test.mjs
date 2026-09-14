import assert from "node:assert/strict";
import test from "node:test";

import {
  FML_LAND_SCAN_INTERVAL_MS,
  getFmlLandHarvestPlan,
  shouldScanFmlLand,
  summarizeFmlLandStatus,
} from "./fml-land-state.mjs";

test("summarizeFmlLandStatus reads guild land from fmlTot and finds mature flower counts", () => {
  const status = summarizeFmlLandStatus({
    fmlTot: {
      fmlLand: {
        landMap: {
          201: {
            flwId: 23001,
            lvl: 2,
            matureFlwCnt: 3,
            startTime: "2026-06-17T00:00:00.000Z",
          },
          202: {
            flowerId: 23002,
            lvl: 1,
            matureFlwCnt: 0,
          },
        },
      },
    },
  });

  assert.equal(status.exists, true);
  assert.equal(status.total, 2);
  assert.equal(status.harvestableCount, 1);
  assert.deepEqual(status.harvestableLandIds, [201]);
  assert.equal(status.rows[0].flowerId, 23001);
  assert.equal(status.rows[0].matureFlwCnt, 3);
  assert.equal(status.rows[0].canHarvest, true);
  assert.equal(status.rows[1].canHarvest, false);
});

test("getFmlLandHarvestPlan returns a selective harvest action for mature guild lands", () => {
  const status = summarizeFmlLandStatus({
    fmlTot: {
      fmlLand: {
        landMap: {
          301: { flwId: 23003, matureFlwCnt: 1 },
          302: { flwId: 23004, matureFlwCnt: 5 },
        },
      },
    },
  });

  assert.deepEqual(getFmlLandHarvestPlan(status), {
    type: "harvestFmlLand",
    iface: "gs.fmlLand.harvest",
    args: { landIds: [301, 302] },
    requestedCount: 2,
  });
});

test("summarizeFmlLandStatus estimates mature guild land rounds from guild land level time", () => {
  const baseMs = Date.parse("2026-06-17T08:00:00.000Z");
  const status = summarizeFmlLandStatus({
    cultivateTot: {
      cultivateMap: {
        23105: {
          flowerId: 23105,
          lvl: 12,
        },
      },
    },
    fmlTot: {
      fmlLand: {
        landMap: {
          401: {
            flwId: 23105,
            lvl: 3,
            matureFlwCnt: 0,
            startTime: new Date(baseMs).toISOString(),
            lastCalcTime: new Date(baseMs).toISOString(),
          },
        },
      },
    },
  }, {
    nowMs: baseMs + 6 * 60 * 1000 + 1,
    fmlLandLevelConfig: {
      fmlLandLvlById: new Map([
        ["3", { id: 3, time: 60, stock: 6 }],
      ]),
    },
  });

  assert.equal(status.harvestableCount, 1);
  assert.deepEqual(status.harvestableLandIds, [401]);
  assert.equal(status.rows[0].canHarvest, true);
  assert.equal(status.rows[0].statusText, "可收获");
  assert.equal(status.rows[0].matureFlwCnt, 0);
  assert.equal(status.rows[0].estimatedMatureFlwCnt, 6);
  assert.equal(status.rows[0].displayMatureFlwCnt, 6);
  assert.equal(status.rows[0].stock, 6);
  assert.equal(status.rows[0].matureAtMs, baseMs + 60 * 1000);
  assert.equal(status.rows[0].maturitySeconds, 60);
  assert.equal(status.rows[0].matureSource, "estimated-fml-land-level");
});

test("summarizeFmlLandStatus uses lastCalcTime as the guild land growth baseline", () => {
  const startMs = Date.parse("2026-06-17T08:00:00.000Z");
  const lastCalcMs = Date.parse("2026-06-17T08:10:00.000Z");
  const status = summarizeFmlLandStatus({
    fmlTot: {
      fmlLand: {
        landMap: {
          402: {
            flwId: 23105,
            lvl: 3,
            matureFlwCnt: 0,
            startTime: new Date(startMs).toISOString(),
            lastCalcTime: new Date(lastCalcMs).toISOString(),
          },
        },
      },
    },
  }, {
    nowMs: lastCalcMs + 59 * 1000,
    fmlLandLevelConfig: {
      fmlLandLvlById: new Map([
        ["3", { id: 3, time: 60, stock: 6 }],
      ]),
    },
  });

  assert.equal(status.harvestableCount, 0);
  assert.equal(status.rows[0].canHarvest, false);
  assert.equal(status.rows[0].estimatedMatureFlwCnt, 0);
  assert.equal(status.rows[0].matureAtMs, lastCalcMs + 60 * 1000);
  assert.equal(status.rows[0].matureSource, "fml-land-level-timer");
});

test("shouldScanFmlLand only opens the 15 minute scan window when due", () => {
  const nowMs = Date.parse("2026-06-17T12:15:00.000Z");

  assert.equal(FML_LAND_SCAN_INTERVAL_MS, 15 * 60 * 1000);
  assert.equal(shouldScanFmlLand({ lastScanAtMs: 0, nowMs }), true);
  assert.equal(shouldScanFmlLand({ lastScanAtMs: nowMs - FML_LAND_SCAN_INTERVAL_MS + 1, nowMs }), false);
  assert.equal(shouldScanFmlLand({ lastScanAtMs: nowMs - FML_LAND_SCAN_INTERVAL_MS, nowMs }), true);
});
