import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLoopRefreshWaterDropFlow,
  buildWaterDropFlow,
  compactWaterDropSnapshot,
  decorateWaterDropStatus,
} from "./water-drop-status.mjs";

test("decorateWaterDropStatus preserves display and restore text", () => {
  const decorated = decorateWaterDropStatus({
    baseCount: 3,
    count: 4,
    restoredCount: 1,
    displayLimit: 10,
    restoreIntervalSeconds: 60,
    restoreStartMs: null,
    nextRestoreAtMs: null,
    nextRestoreInSeconds: null,
  });

  assert.equal(decorated.restoreIntervalText, "1分00秒");
  assert.equal(decorated.restoreStartText, "-");
  assert.equal(decorated.nextRestoreAtText, "-");
  assert.equal(decorated.nextRestoreText, "无恢复倒计时");
  assert.equal(decorated.formulaText, "基数 3 + 自然恢复 1 / 上限 10");
  assert.equal(decorated.displayText, "4/10");
});

test("water drop flow keeps the before and after compact snapshots", () => {
  const before = { baseCount: 3, count: 5, restoredCount: 2, displayText: "5/10", restoreStartText: "-", nextRestoreText: "1分00秒" };
  const after = { baseCount: 2, count: 3, restoredCount: 1, displayText: "3/10", restoreStartText: "-", nextRestoreText: "2分00秒" };
  const flow = buildWaterDropFlow(before, after, 2);

  assert.deepEqual(flow.beforeWater, compactWaterDropSnapshot(before));
  assert.deepEqual(flow.afterCycle, compactWaterDropSnapshot(after));
  assert.equal(flow.restoredBeforeWater, 2);
  assert.equal(flow.wateredCount, 2);
  assert.equal(flow.netChange, -2);
  assert.equal(flow.flowText, "浇水前 5/10，自然恢复 2；本轮自动浇水消耗 2；结束 3/10");
});

test("loop refresh flow is an observation-only snapshot", () => {
  const waterDrop = { baseCount: 2, count: 4, restoredCount: 2, displayText: "4/10", restoreStartText: "-", nextRestoreText: "1分00秒" };
  const flow = buildLoopRefreshWaterDropFlow(waterDrop);

  assert.equal(flow.mode, "loop-refresh-snapshot");
  assert.equal(flow.wateredCount, 0);
  assert.equal(flow.netChange, 0);
  assert.deepEqual(flow.beforeWater, flow.afterCycle);
  assert.equal(flow.flowText, "休眠刷新快照：当前水滴 4/10；本次刷新未执行种植、浇水或领水");
});

