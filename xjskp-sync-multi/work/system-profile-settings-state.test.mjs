import assert from "node:assert/strict";
import test from "node:test";

import {
  beginProfileSettingsUpdate,
  getTeamOrderProtectionView,
  rollbackProfileSettingsUpdate,
} from "./system/public/profile-settings-state.js";

test("profile setting rollback restores only the account whose save failed", () => {
  const first = {
    id: "p1",
    settings: {
      teamOrderTriggerProtectionEnabled: true,
      experienceGuardThresholdPercent: 0.5,
    },
  };
  const second = {
    id: "p2",
    settings: { teamOrderTriggerProtectionEnabled: false },
  };

  const transaction = beginProfileSettingsUpdate(first, {
    teamOrderTriggerProtectionEnabled: false,
    experienceGuardThresholdPercent: 0.37,
  });
  assert.equal(first.settings.teamOrderTriggerProtectionEnabled, false);
  assert.equal(first.settings.experienceGuardThresholdPercent, 0.37);
  assert.equal(second.settings.teamOrderTriggerProtectionEnabled, false);

  assert.equal(rollbackProfileSettingsUpdate(second, transaction), false);
  assert.equal(second.settings.teamOrderTriggerProtectionEnabled, false);
  assert.equal(rollbackProfileSettingsUpdate(first, transaction), true);
  assert.equal(first.settings.teamOrderTriggerProtectionEnabled, true);
  assert.equal(first.settings.experienceGuardThresholdPercent, 0.5);
});

test("team-order release view defaults to off and explains both states", () => {
  assert.deepEqual(getTeamOrderProtectionView({}), {
    releaseEnabled: false,
    description: "未放行：在第 49/99 单停止，避免自动触发组团。",
  });
  assert.deepEqual(getTeamOrderProtectionView({
    teamOrderTriggerProtectionEnabled: false,
  }), {
    releaseEnabled: true,
    description: "已放行：仅在双倍金币剩余超过3分钟时，才允许跨过 49/99 触发免费组团；是否付费续开由元宝续次数放行独立控制。",
  });
  assert.deepEqual(getTeamOrderProtectionView({
    teamOrderTriggerProtectionEnabled: false,
  }, {
    teamOrderDoubleGoldReady: false,
    teamOrderDoubleGoldRemainingText: "3分00秒",
  }), {
    releaseEnabled: true,
    description: "已放行（当前仍强制保护）：双倍金币剩余 3分00秒，必须超过3分钟才允许跨过 49/99。",
  });
});
