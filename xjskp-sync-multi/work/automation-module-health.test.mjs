import test from "node:test";
import assert from "node:assert/strict";

import {
  createAutomationModuleHealthRegistry,
  resolvePersistentCycleErrors,
} from "./automation-module-health.mjs";
import { createFlowerLevelConfig } from "./flower-level-config.mjs";
import { autoUpgradeFlowers } from "./inspect-garden-dryrun.mjs";

test("module health keeps failures until the same module and fingerprint succeeds", () => {
  let nowMs = Date.parse("2026-08-11T00:00:00.000Z");
  const health = createAutomationModuleHealthRegistry({ now: () => nowMs });

  health.failure("flowerUpgrade", { code: 301, param: { iid: 11 } }, {
    cycle: 7,
    fingerprint: "flower:23001:level:1",
    backoffMs: 60_000,
  });
  health.success("teamOrder", { cycle: 7 });

  let snapshot = health.snapshot();
  assert.equal(snapshot.status, "degraded");
  assert.equal(snapshot.unhealthyCount, 1);
  assert.equal(snapshot.modules.flowerUpgrade.lastError.code, "301");
  assert.equal(snapshot.modules.flowerUpgrade.lastError.param.iid, 11);
  assert.equal(snapshot.modules.teamOrder.status, "healthy");
  assert.equal(health.canAttempt("flowerUpgrade", "flower:23001:level:1").allowed, false);
  assert.equal(health.canAttempt("flowerUpgrade", "flower:23001:level:2").allowed, true);

  nowMs += 60_001;
  assert.equal(health.canAttempt("flowerUpgrade", "flower:23001:level:1").allowed, true);
  health.success("flowerUpgrade", { cycle: 8, fingerprint: "flower:23001:level:1" });
  snapshot = health.snapshot();
  assert.equal(snapshot.status, "healthy");
  assert.equal(snapshot.unhealthyCount, 0);
});

test("loop refresh preserves the previous cycle errors when it has no new cycle summary", () => {
  const previous = [{ step: "flowerUpgradeError", message: "server-rejected:301" }];
  assert.deepEqual(resolvePersistentCycleErrors({
    statusMode: "loop-refresh",
    currentErrors: undefined,
    previousErrors: previous,
  }), previous);
  assert.deepEqual(resolvePersistentCycleErrors({
    statusMode: "cycle-action",
    currentErrors: undefined,
    previousErrors: previous,
  }), []);
  assert.deepEqual(resolvePersistentCycleErrors({
    statusMode: "loop-refresh",
    currentErrors: [],
    previousErrors: previous,
  }), []);
});

test("deterministic flower upgrade rejection backs off until stable upgrade inputs change", async () => {
  const health = createAutomationModuleHealthRegistry({
    now: () => Date.parse("2026-08-11T00:00:00.000Z"),
  });
  const config = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: -1, $lvlMax: 20 },
      { id: 23001, gldCost: 100 },
    ],
    flowerLvlCfgRows: [{ id: 1, gldCost: 100, lvlUpCost: 1 }],
    flowerRows: [{ id: 23001, eliteId: 22001 }],
  });
  const makeSync = (gold, eliteCount = 10) => ({
    $usrTot: { data: { gld: gold, bag: { 22001: eliteCount } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 1 } } },
  });
  let requests = 0;
  const ws = {
    async request() {
      requests += 1;
      return { m: { code: 301, param: { iid: 11 } } };
    },
  };

  const first = await autoUpgradeFlowers(ws, "token", makeSync(1_000), {
    cycle: 1,
    flowerLevelConfig: config,
    moduleHealth: health,
    rejectionBackoffMs: 60_000,
  });
  const second = await autoUpgradeFlowers(ws, "token", makeSync(1_000), {
    cycle: 2,
    flowerLevelConfig: config,
    moduleHealth: health,
    rejectionBackoffMs: 60_000,
  });
  const third = await autoUpgradeFlowers(ws, "token", makeSync(1_001), {
    cycle: 3,
    flowerLevelConfig: config,
    moduleHealth: health,
    rejectionBackoffMs: 60_000,
  });
  const fourth = await autoUpgradeFlowers(ws, "token", makeSync(1_001, 9), {
    cycle: 4,
    flowerLevelConfig: config,
    moduleHealth: health,
    rejectionBackoffMs: 60_000,
  });

  assert.equal(requests, 2);
  assert.equal(first.failedCount, 1);
  assert.equal(second.skippedBackoffCount, 1);
  assert.equal(third.skippedBackoffCount, 1);
  assert.equal(fourth.failedCount, 1);
  assert.equal(health.snapshot().modules.flowerUpgrade.status, "degraded");
});

test("301 flower upgrade rejection remains a failure while later candidates continue", async () => {
  const health = createAutomationModuleHealthRegistry();
  const attemptedFlowerIds = [];
  const ws = {
    async request(iface, args) {
      assert.equal(iface, "gs.cultivate.upgrade");
      attemptedFlowerIds.push(args.flowerId);
      if (args.flowerId === 23001) {
        return { m: { code: 301, param: { iid: 22001 } } };
      }
      return { v: { cultivateTot: { cultivateMap: { 23002: { flowerId: 23002, lvl: 20 } } } } };
    },
  };

  const result = await autoUpgradeFlowers(ws, "token", {
    $usrTot: { data: { gld: 1_000, bag: { 22001: 10, 22002: 10 } } },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 1 },
        23002: { flowerId: 23002, lvl: 2 },
      },
    },
  }, {
    cycle: 1,
    flowerLevelConfig: createFlowerLevelConfig({
      flowerLvlRows: [
        { id: -1, $lvlMax: 20 },
        { id: 23001, gldCost: 100 },
        { id: 23002, gldCost: 100 },
      ],
      flowerLvlCfgRows: [
        { id: 1, gldCost: 100, lvlUpCost: 1 },
        { id: 2, gldCost: 200, lvlUpCost: 2 },
      ],
      flowerRows: [
        { id: 23001, eliteId: 22001 },
        { id: 23002, eliteId: 22002 },
      ],
    }),
    moduleHealth: health,
    rejectionBackoffMs: 60_000,
  });

  assert.deepEqual(attemptedFlowerIds, [23001, 23002]);
  assert.equal(result.failedCount, 1);
  assert.equal(result.upgradedCount, 1);
  assert.equal(result.failedActions[0].error.code, 301);
  assert.equal(health.snapshot().modules.flowerUpgrade.status, "degraded");
});
