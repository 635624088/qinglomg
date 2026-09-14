import assert from "node:assert/strict";
import test from "node:test";

import { createFlowerLevelConfig } from "./flower-level-config.mjs";
import {
  getFlowerUpgradeCandidates,
  summarizeUpgradeStatus,
} from "./flower-upgrade-state.mjs";

function makeConfig() {
  return createFlowerLevelConfig({
    flowerLvlRows: [
      { id: -1, $lvlMax: 20 },
      { id: 23001, gldCost: 100 },
      { id: 23002, gldCost: 100 },
      { id: 23003, gldCost: 100 },
    ],
    flowerLvlCfgRows: [
      { id: 1, gldCost: 100, lvlUpCost: 1 },
      { id: 2, gldCost: 200, lvlUpCost: 2 },
      { id: 3, gldCost: 400, lvlUpCost: 4 },
    ],
    flowerRows: [
      { id: 23001, seedId: 21001, eliteId: 22001 },
      { id: 23002, seedId: 21002, eliteId: 22002 },
      { id: 23003, seedId: 21003, eliteId: 22003 },
    ],
  });
}

function makeSync(overrides = {}) {
  return {
    $usrTot: {
      data: {
        gld: 500,
        bag: { 22001: 10, 22002: 1, 22003: 100 },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 1 },
        23002: { flowerId: 23002, lvl: 2 },
        23003: { flowerId: 23003, lvl: 3 },
      },
    },
    ...overrides,
  };
}

test("getFlowerUpgradeCandidates filters by gold and elite counts", () => {
  const candidates = getFlowerUpgradeCandidates(makeSync(), makeConfig());

  assert.deepEqual(candidates.map((c) => c.flowerId), [23001, 23003]);
  assert.deepEqual(candidates[0], {
    flowerId: 23001,
    lvl: 1,
    maxLvl: 20,
    eliteId: 22001,
    eliteCost: 1,
    gldCost: 100,
  });
});

test("getFlowerUpgradeCandidates skips flowers when gold is insufficient", () => {
  const candidates = getFlowerUpgradeCandidates(
    makeSync({ $usrTot: { data: { gld: 50, bag: { 22001: 10, 22002: 1, 22003: 100 } } } }),
    makeConfig(),
  );

  assert.deepEqual(candidates, []);
});

test("getFlowerUpgradeCandidates does not use the lower generic cost when an exact flower cost exists", () => {
  const config = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: -1, $lvlMax: 20 },
      { id: 2302010, gldCost: 105000, lvlUpCost: [22020, 180] },
    ],
    flowerLvlCfgRows: [
      { id: 1, gldCost: 100, lvlUpCost: 1 },
      { id: 10, gldCost: 10000, lvlUpCost: 180 },
    ],
    flowerRows: [{ id: 23020, seedId: 21020, eliteId: 22020 }],
  });
  const sync = {
    $usrTot: { data: { gld: 13703, bag: { 22020: 217 } } },
    cultivateTot: { cultivateMap: { 23020: { flowerId: 23020, lvl: 10 } } },
  };

  assert.deepEqual(getFlowerUpgradeCandidates(sync, config), []);
});

test("getFlowerUpgradeCandidates skips max level flowers", () => {
  const sync = makeSync();
  sync.cultivateTot.cultivateMap["23001"].lvl = 20;

  const candidates = getFlowerUpgradeCandidates(sync, makeConfig());

  assert.deepEqual(candidates.map((c) => c.flowerId), [23003]);
});

test("getFlowerUpgradeCandidates returns empty when cultivateMap is missing", () => {
  const candidates = getFlowerUpgradeCandidates(makeSync({ cultivateTot: {} }), makeConfig());

  assert.deepEqual(candidates, []);
});

test("getFlowerUpgradeCandidates accepts lvl/level/lv level fields", () => {
  const sync = makeSync();
  sync.cultivateTot.cultivateMap = {
    23001: { flowerId: 23001, lvl: 1 },
    23002: { flowerId: 23002, level: 1 },
    23003: { flowerId: 23003, lv: 1 },
  };

  const candidates = getFlowerUpgradeCandidates(sync, makeConfig());

  assert.deepEqual(candidates.map((c) => c.flowerId), [23001, 23002, 23003]);
});

test("getFlowerUpgradeCandidates sorts by lvl ascending then flowerId ascending", () => {
  const sync = makeSync();
  sync.cultivateTot.cultivateMap = {
    23001: { flowerId: 23001, lvl: 2 },
    23002: { flowerId: 23002, lvl: 1 },
    23003: { flowerId: 23003, lvl: 1 },
  };
  sync.$usrTot.data.gld = 1000;
  sync.$usrTot.data.bag = { 22001: 10, 22002: 10, 22003: 10 };

  const candidates = getFlowerUpgradeCandidates(sync, makeConfig());

  assert.deepEqual(
    candidates.map((c) => [c.flowerId, c.lvl]),
    [[23002, 1], [23003, 1], [23001, 2]],
  );
});

test("summarizeUpgradeStatus reports per-flower detail and totals", () => {
  const summary = summarizeUpgradeStatus(makeSync(), makeConfig());

  assert.equal(summary.total, 3);
  assert.equal(summary.maxed, 0);
  assert.equal(summary.upgradable, 2);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.nextCandidate?.flowerId, 23001);

  const byId = Object.fromEntries(summary.rows.map((r) => [r.flowerId, r]));
  assert.equal(byId[23001].upgradable, true);
  assert.equal(byId[23001].reason, "ok");
  assert.equal(byId[23002].upgradable, false);
  assert.equal(byId[23002].reason, "elite");
  assert.equal(byId[23003].upgradable, true);
});

test("summarizeUpgradeStatus marks maxed and missing-config rows", () => {
  const sync = makeSync();
  sync.cultivateTot.cultivateMap["23001"].lvl = 20;
  sync.cultivateTot.cultivateMap[99999] = { flowerId: 99999, lvl: 1 };

  const summary = summarizeUpgradeStatus(sync, makeConfig());

  const byId = Object.fromEntries(summary.rows.map((r) => [r.flowerId, r]));
  assert.equal(byId[23001].reason, "maxed");
  assert.equal(byId[23001].upgradable, false);
  assert.equal(byId[99999].reason, "no-config");
  assert.equal(byId[99999].upgradable, false);
  assert.equal(summary.maxed, 1);
});
