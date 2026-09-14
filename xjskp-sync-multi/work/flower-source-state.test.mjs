import assert from "node:assert/strict";
import test from "node:test";

import {
  createFlowerSourceConfig,
  getFlowerAcquisitionInfo,
} from "./flower-source-state.mjs";

test("getFlowerAcquisitionInfo reads acquisition source from the flower seed item", () => {
  const config = createFlowerSourceConfig({
    flowerRows: [
      { id: 23087, seedId: 21087, eliteId: 22087 },
      { id: 23280, seedId: 21280, eliteId: 22280 },
    ],
    itemRows: [
      { id: 21087, name: "淡茜蜀葵花种子", getWayText: "花坊兑换", getWayPram: "花坊币兑换" },
      { id: 21280, name: "棉花小熊种子", getWayText: "首充壕礼" },
      { id: 23087, name: "淡茜蜀葵花", getWayText: "前往种植" },
    ],
  });

  assert.deepEqual(getFlowerAcquisitionInfo(23087, config), {
    flowerId: 23087,
    seedId: 21087,
    eliteId: 22087,
    seedName: "淡茜蜀葵花种子",
    getWays: [],
    getWayText: "花坊兑换",
    getWayPram: "花坊币兑换",
    getWayIcon: [],
    sourceText: "花坊兑换；花坊币兑换",
  });
  assert.equal(getFlowerAcquisitionInfo(23280, config).sourceText, "首充壕礼");
});

