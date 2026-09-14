import test from "node:test";
import assert from "node:assert/strict";

import { buildFlowerNameMap } from "./extract-flower-names.mjs";

test("buildFlowerNameMap derives names from candidate item and flower tables without writing files", () => {
  const config = {
    c_item: plainTable({
      100: { name: "普通物品", bType: 1 },
      23001: { name: "红玫瑰", bType: 2 },
      23002: { name1: "白玫瑰", bType: 1 },
    }),
    c_flower: plainTable({
      23001: {},
      23002: {},
    }),
  };

  assert.deepEqual(buildFlowerNameMap(config), {
    23001: "红玫瑰",
    23002: "白玫瑰",
  });
});

function plainTable(rows) {
  return {
    colMap: { $: "id", name: "name", name1: "name1", sname: "sname", bType: "bType" },
    list: [{ v: rows }],
  };
}
