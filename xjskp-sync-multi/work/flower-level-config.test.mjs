import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlowerLevelConfig,
  getFlowerLevelInfo,
  getFlowerMaturitySeconds,
  getFlowerUpgradeRequirement,
  loadFlowerLevelConfig,
} from "./flower-level-config.mjs";

test("getFlowerLevelInfo converts exact flower level cd ticks to real seconds", () => {
  const config = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: 2300102, cd: 104 },
      { id: 23001, cd: 800 },
    ],
    flowerLvlCfgRows: [
      { id: 1, cd: 100 },
      { id: 2, cd: 200 },
    ],
  });

  const info = getFlowerLevelInfo(23001, 2, config);

  assert.equal(info.seconds, 104);
  assert.equal(info.rawCd, 104);
  assert.equal(info.timeStep, 1);
  assert.equal(info.source, "exact");
});

test("getFlowerLevelInfo applies frontend formula then converts cd ticks to real seconds", () => {
  const config = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: 23001, cd: 840 },
    ],
    flowerLvlCfgRows: [
      { id: 1, cd: 84 },
      { id: 2, cd: 85 },
    ],
  });

  const info = getFlowerLevelInfo(23001, 2, config);

  assert.equal(info.seconds, 850);
  assert.equal(info.rawCd, 850);
  assert.equal(info.timeStep, 1);
  assert.equal(info.source, "formula");
  assert.equal(getFlowerMaturitySeconds(23001, 2, config), 850);
});

test("getFlowerLevelInfo subtracts flower advance harvest interval skill seconds", () => {
  const config = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: 2300111, cd: 104 },
      { id: 2300712, cd: 324 },
    ],
    flowerAdvanceSkillRows: [
      { id: 5001, skillType: 5, valueType: 1, value1: 63, value2: 64, value3: 65 },
    ],
  });

  const whiteLily = getFlowerLevelInfo(23001, 11, config, {
    advanceSlotMap: {
      1: { slotId: 1, skillId: 5001 },
    },
  });
  const violet = getFlowerLevelInfo(23007, 12, config, {
    advanceSlotMap: {
      2: { slotId: 2, skillId: 5001 },
    },
  });

  assert.equal(whiteLily.seconds, 41);
  assert.equal(whiteLily.rawCd, 104);
  assert.equal(whiteLily.advanceHarvestIntervalReductionSeconds, 63);
  assert.deepEqual(whiteLily.advanceEffects, { 5: 63 });
  assert.equal(whiteLily.advanceSlots[0].slotId, 1);
  assert.equal(whiteLily.advanceSlots[0].skillType, 5);

  assert.equal(violet.seconds, 260);
  assert.equal(violet.rawCd, 324);
  assert.equal(violet.advanceHarvestIntervalReductionSeconds, 64);
});

test("loadFlowerLevelConfig decodes encrypted runtime cd values like the game client", () => {
  const config = loadFlowerLevelConfig();

  const whiteLily11 = getFlowerLevelInfo(23001, 11, config);
  const whiteLily12 = getFlowerLevelInfo(23001, 12, config);
  const violet12 = getFlowerLevelInfo(23007, 12, config);

  assert.equal(whiteLily11.seconds, 41);
  assert.equal(whiteLily11.rawCd, 41);
  assert.equal(whiteLily11.source, "exact");
  assert.equal(whiteLily12.seconds, 37);
  assert.equal(violet12.seconds, 260);
});

test("getFlowerLevelInfo returns null seconds when config is missing", () => {
  const config = createFlowerLevelConfig();

  const info = getFlowerLevelInfo(23001, 2, config);

  assert.equal(info.seconds, null);
  assert.equal(info.source, "missing");
});

test("getFlowerUpgradeRequirement reads eliteId and level costs from decoded config", () => {
  const config = createFlowerLevelConfig({
    flowerLvlRows: [
      { id: -1, $lvlMax: 20 },
      { id: 23001, gldCost: 100 },
    ],
    flowerLvlCfgRows: [
      { id: 1, gldCost: 100, lvlUpCost: 1 },
      { id: 2, gldCost: 200, lvlUpCost: 2 },
    ],
    flowerRows: [{ id: 23001, seedId: 21001, eliteId: 22001 }],
  });

  const requirement = getFlowerUpgradeRequirement(23001, 1, config);

  assert.equal(requirement.upgradable, true);
  assert.equal(requirement.eliteId, 22001);
  assert.equal(requirement.eliteCost, 1);
  assert.equal(requirement.gldCost, 100);
  assert.equal(requirement.maxLvl, 20);
  assert.equal(requirement.lvl, 1);

  const next = getFlowerUpgradeRequirement(23001, 2, config);
  assert.equal(next.upgradable, true);
  assert.equal(next.gldCost, 200);
  assert.equal(next.eliteCost, 2);
});

test("getFlowerUpgradeRequirement prefers flower-specific costs used by the client", () => {
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

  const requirement = getFlowerUpgradeRequirement(23020, 10, config);

  assert.equal(requirement.upgradable, true);
  assert.equal(requirement.gldCost, 105000);
  assert.equal(requirement.eliteId, 22020);
  assert.equal(requirement.eliteCost, 180);
});

test("getFlowerUpgradeRequirement marks max level flowers as not upgradable", () => {
  const config = createFlowerLevelConfig({
    flowerLvlRows: [{ id: -1, $lvlMax: 20 }],
    flowerLvlCfgRows: [{ id: 19, gldCost: 75000, lvlUpCost: 15000 }],
    flowerRows: [{ id: 23001, seedId: 21001, eliteId: 22001 }],
  });

  const requirement = getFlowerUpgradeRequirement(23001, 20, config);

  assert.equal(requirement.upgradable, false);
  assert.equal(requirement.maxLvl, 20);
  assert.equal(requirement.lvl, 20);
  assert.equal(requirement.gldCost, null);
});

test("getFlowerUpgradeRequirement decodes real runtime config costs", () => {
  const config = loadFlowerLevelConfig();

  const lv19 = getFlowerUpgradeRequirement(23001, 19, config);

  assert.equal(lv19.upgradable, true);
  assert.equal(lv19.eliteId, 22001);
  assert.equal(lv19.gldCost, 60000);
  assert.equal(lv19.eliteCost, 15000);
  assert.equal(lv19.maxLvl, 20);

  const maxed = getFlowerUpgradeRequirement(23001, 20, config);
  assert.equal(maxed.upgradable, false);
});

test("getFlowerUpgradeRequirement returns safe empty values when config or flower is missing", () => {
  const empty = createFlowerLevelConfig();
  const missing = getFlowerUpgradeRequirement(23001, 1, empty);

  assert.equal(missing.upgradable, false);
  assert.equal(missing.eliteId, null);
  assert.equal(missing.eliteCost, null);
  assert.equal(missing.gldCost, null);
  assert.equal(missing.maxLvl, 20);

  const noFlower = getFlowerUpgradeRequirement(99999, 1, loadFlowerLevelConfig());
  assert.equal(noFlower.upgradable, false);
  assert.equal(noFlower.eliteId, null);
});
