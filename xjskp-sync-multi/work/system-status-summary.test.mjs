import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import { buildProfileStatusSummary } from "./system/status-summary.mjs";

test("buildProfileStatusSummary extracts dashboard-ready garden and order facts", () => {
  const statusDir = "runtime/status/main";
  const logDir = "runtime/logs/main";
  const result = buildProfileStatusSummary({
    profileId: "main",
    statusDir,
    logDir,
    gardenStatus: {
      ok: true,
      path: path.join(statusDir, "garden-status.json"),
      data: {
        updatedAt: "2026-06-29 17:36:41",
        cycle: 116,
        step: "loopStatusRefresh",
        summary: {
          totalLand: 60,
          emptyCount: 0,
          growingCount: 60,
          matureCount: 0,
          waterDropText: "37/65",
          waterDropNextRestoreText: "1分13秒",
          goldCount: 4908430,
          goldText: "4908430",
          pearlText: "868",
          flowerShopCoinText: "1669",
          satinSilkText: "597",
          buildingMaterialText: "277",
          yuanbaoText: "169",
          doubleGoldRemainingText: "9分50秒",
          cycleErrorCount: 0,
          loopError: null,
          accountLevel: {
            level: 40,
            currentExp: 2760828,
            requiredExp: 9919000,
            progressText: "2760828/9919000",
            serverIdx: 726,
            serverText: "区服 726",
          },
          experienceGuard: {
            thresholdPercent: 0.5,
            thresholdRemainingExp: 49595,
            protectionLimitExp: 9869405,
            remainingToProtectionExp: 7108577,
            known: true,
            blocked: false,
            level: 40,
            currentExp: 2760828,
            requiredExp: 9919000,
            remainingExp: 7158172,
            progressPercent: 27.83,
            reason: "action-level-check",
            reasonText: "经验保护（0.5%门槛）：当前 27.8%，距离升级 715,8172，距保护线 710,8577，收益动作正常，执行前按预测经验上界复核",
          },
        },
        pearl: {
          hireItemCount: 24,
        },
        automationQueue: {
          nextMatureText: "3分48秒",
          rows: [
            { area: "土地补种", pending: 0, status: "暂无同熟窗口阻断" },
            { area: "珍珠采集", pending: 1, status: "可收取/可雇佣，雇佣卡 24", gateReason: "level-up-main-task" },
          ],
        },
        landRows: [
          { landId: 1001, flowerName: "忽地笑", statusText: "成长中", remainingText: "3分48秒" },
        ],
        flowerArtInventory: { total: 2 },
        inventorySorted: [{ flowerId: 23001 }],
        cultivatedInventorySorted: [{ flowerId: 23001 }],
        uncultivatedInventorySorted: [{ flowerId: 23002 }],
      },
    },
    orderStatus: {
      ok: true,
      path: path.join(statusDir, "order-status.json"),
      data: {
        residentBoard: { completedCount: 425 },
        ordinary: { readyCount: 6 },
        pendingCustomerOrderActions: [{ action: "make" }],
      },
    },
    logs: [
      { name: "auto-plant-20260629-173641.log", size: 2048 },
    ],
  });

  assert.equal(result.profileId, "main");
  assert.equal(result.ok, true);
  assert.deepEqual(result.land, {
    total: 60,
    empty: 0,
    growing: 60,
    mature: 0,
    nextMatureText: "3分48秒",
  });
  assert.equal(result.resources.waterDropText, "37/65");
  assert.equal(result.resources.goldText, "490,8430");
  assert.equal(result.resources.hireItemCountText, 24);
  assert.equal(result.accountLevel.serverIdx, 726);
  assert.equal(result.accountLevel.serverText, "区服 726");
  assert.equal(result.accountLevel.progressText, "276,0828/991,9000（27.8%）");
  assert.equal(result.experienceGuard.blocked, false);
  assert.equal(result.experienceGuard.thresholdRemainingExp, 49595);
  assert.equal(result.risk.experienceGuardText, "经验保护（0.5%门槛）：当前 27.8%，距离升级 715,8172，距保护线 710,8577，收益动作正常，执行前按预测经验上界复核");
  assert.equal(result.resources.doubleGoldRemainingText, "9分50秒");
  assert.equal(result.queue.length, 2);
  assert.equal(result.queue[1].state, "pending");
  assert.equal(result.queue[1].gateReason, "level-up-main-task");
  assert.equal(result.orders.residentBoardCompletedCount, 425);
  assert.equal(result.orders.customerPendingCount, 1);
  assert.deepEqual(result.inventory, {
    total: 1,
    cultivated: 1,
    uncultivated: 1,
    flowerArt: 2,
  });
  assert.equal(result.artifacts.gardenHtmlPath, path.join(statusDir, "garden-status.html"));
  assert.equal(result.logs[0].name, "auto-plant-20260629-173641.log");
});

test("buildProfileStatusSummary reports missing status without throwing", () => {
  const result = buildProfileStatusSummary({
    profileId: "main",
    statusDir: "runtime/status/main",
    logDir: "runtime/logs/main",
    gardenStatus: { ok: false, errorType: "not-found", path: "runtime/status/main/garden-status.json" },
    orderStatus: { ok: false, errorType: "not-found", path: "runtime/status/main/order-status.json" },
    logs: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "garden-status-not-found");
  assert.equal(result.land.total, null);
  assert.equal(result.resources.hireItemCountText, "-");
  assert.equal(result.queue.length, 0);
});

test("buildProfileStatusSummary exposes login-state stop risk", () => {
  const result = buildProfileStatusSummary({
    profileId: "main",
    statusDir: "runtime/status/main",
    logDir: "runtime/logs/main",
    gardenStatus: {
      ok: true,
      path: "runtime/status/main/garden-status.json",
      data: {
        updatedAt: "2026-06-30 16:00:00",
        cycle: 7,
        step: "sessionExpiredStop",
        summary: {
          totalLand: 60,
          cycleErrorCount: 0,
          loopError: "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。",
          automationStopped: {
            stopped: true,
            reason: "session-expired",
            category: "login-state",
            message: "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。",
            stoppedAt: "2026-06-30 16:00:00",
            exitCode: 42,
          },
        },
        automationQueue: { rows: [] },
      },
    },
    orderStatus: { ok: false, errorType: "not-found" },
    logs: [],
  });

  assert.equal(result.risk.loopError, "检测到账号在其他设备登录或会话已失效，自动化循环已自动停止。");
  assert.equal(result.risk.loginState, "expired");
  assert.equal(result.risk.loginStateText, "已失效");
  assert.equal(result.risk.automationStopped.reason, "session-expired");
  assert.equal(result.risk.automationStopped.exitCode, 42);
});

test("buildProfileStatusSummary exposes experience guard stop risk", () => {
  const result = buildProfileStatusSummary({
    profileId: "main",
    statusDir: "runtime/status/main",
    logDir: "runtime/logs/main",
    gardenStatus: {
      ok: true,
      path: "runtime/status/main/garden-status.json",
      data: {
        updatedAt: "2026-07-06 16:00:00",
        cycle: 8,
        step: "experienceGuardStop",
        experienceGuard: {
          thresholdPercent: 0.5,
          thresholdRemainingExp: 50000,
          protectionLimitExp: 9950000,
          remainingToProtectionExp: 0,
          thresholdReached: true,
          known: true,
          blocked: true,
          level: 40,
          currentExp: 9950000,
          requiredExp: 10000000,
          remainingExp: 50000,
          progressPercent: 99.5,
          reason: "experience-protection-boundary",
          reasonText: "经验保护（0.5%门槛）：当前 99.5%，距离升级 5,0000，距保护线 0，已到0.5%保护线，已停止收益类自动任务",
        },
        summary: {
          totalLand: 60,
          cycleErrorCount: 0,
          loopError: "经验保护（0.5%门槛）：当前 99.5%，距离升级 5,0000，距保护线 0，已到0.5%保护线，已停止收益类自动任务",
          experienceGuard: {
            thresholdPercent: 0.5,
            thresholdRemainingExp: 50000,
            protectionLimitExp: 9950000,
            remainingToProtectionExp: 0,
            thresholdReached: true,
            known: true,
            blocked: true,
            level: 40,
            currentExp: 9950000,
            requiredExp: 10000000,
            remainingExp: 50000,
            progressPercent: 99.5,
            reason: "experience-protection-boundary",
            reasonText: "经验保护（0.5%门槛）：当前 99.5%，距离升级 5,0000，距保护线 0，已到0.5%保护线，已停止收益类自动任务",
          },
          automationStopped: {
            stopped: true,
            reason: "experience-guard",
            category: "experience-guard",
            message: "经验保护（0.5%门槛）：当前 99.5%，距离升级 5,0000，距保护线 0，已到0.5%保护线，已停止收益类自动任务",
            stoppedAt: "2026-07-06 16:00:00",
            exitCode: 43,
          },
        },
        automationQueue: { rows: [] },
      },
    },
    orderStatus: { ok: false, errorType: "not-found" },
    logs: [],
  });

  assert.equal(result.experienceGuard.blocked, true);
  assert.equal(result.risk.experienceGuardBlocked, true);
  assert.equal(result.risk.automationStopped.reason, "experience-guard");
  assert.equal(result.risk.loginState, "normal");
});

test("buildProfileStatusSummary exposes persistent module health even without cycle errors", () => {
  const result = buildProfileStatusSummary({
    profileId: "main",
    statusDir: "runtime/status/main",
    logDir: "runtime/logs/main",
    gardenStatus: {
      ok: true,
      data: {
        summary: { cycleErrorCount: 0 },
        moduleHealth: {
          status: "degraded",
          unhealthyCount: 1,
          modules: {
            flowerUpgrade: {
              status: "degraded",
              lastError: { code: "301", message: "server-rejected:301" },
            },
          },
        },
        automationQueue: { rows: [] },
      },
    },
    orderStatus: { ok: false, errorType: "not-found" },
    logs: [],
  });

  assert.equal(result.risk.cycleErrorCount, 0);
  assert.equal(result.risk.moduleHealth.unhealthyCount, 1);
  assert.equal(result.risk.hasAutomationRisk, true);
});
