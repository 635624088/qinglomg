import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const canonicalSettingsControls = {
  autoReceiveWaterwheelBuckets: "waterwheelBucketReceiveToggle",
  skipWaterwheelVideoBuckets: "waterwheelVideoBucketSkipToggle",
  experienceGuardThresholdPercent: "experienceGuardThresholdInput",
  autoSubmitOrdinaryResidentOrdersForLevelUp: "ordinaryAutoSubmitToggle",
  autoSubmitCyclicStoryOrders: "cyclicStoryAutoSubmitToggle",
  cyclicStoryOnlyHighestExperienceOrder: "cyclicStoryOnlyHighestExperienceToggle",
  autoHandleCyclicNote: "cyclicNoteAutomationToggle",
  autoCompleteCyclicNoteHighestRewardTask: "cyclicNoteNaturalCompletionToggle",
  teamOrderTriggerProtectionEnabled: "teamOrderProtectionToggle",
  teamOrderPaidRenewProtectionEnabled: "teamOrderPaidRenewProtectionToggle",
  flowerRackTargetArtId: "flowerRackTargetSelect",
  pearlHireItemReserveCount: "pearlHireItemReserveInput",
  materialShopMidnightRefreshEnabled: "materialShopMidnightRefreshToggle",
  materialShopRefreshWindowStart: "materialShopRefreshWindowStartInput",
  materialShopRefreshMaxCostYuanbao: "materialShopRefreshMaxCostSelect",
  teamOrderGuardMultiplier: "teamOrderGuardMultiplierInput",
};

test("special order UI projects category states and exact missing item details", async () => {
  const { buildSpecialOrderCategoryView } = await import(
    "./system/public/special-order-view.js"
  );
  const stateCases = [
    [{ exists: false, status: "missing-order", statusText: "未生成" }, "未生成/未开启"],
    [{ exists: true, status: "ready", statusText: "可完成" }, "可完成"],
    [{ exists: true, status: "cooldown", statusText: "冷却中", remainingText: "3分20秒" }, "冷却中（3分20秒）"],
    [{ exists: true, status: "daily-limit", statusText: "已达上限" }, "已达上限"],
    [{ exists: true, status: "video", statusText: "视频订单" }, "视频订单"],
    [{ exists: true, status: "error", statusText: "读取失败" }, "读取失败"],
  ];
  for (const [order, expectedStatus] of stateCases) {
    assert.equal(buildSpecialOrderCategoryView(order).status, expectedStatus);
    assert.equal(buildSpecialOrderCategoryView(order).missing, "无");
  }

  const missing = buildSpecialOrderCategoryView({
    exists: true,
    status: "missing-items",
    statusText: "缺少材料",
    requirements: [
      { itemId: 23001, name: "红玫瑰", need: 3, have: 1, missing: 2 },
      { itemId: 23015, name: "黄玫瑰", need: 1, have: 0, missing: 1 },
      { itemId: 23020, name: "蓝玫瑰", need: 2, have: 2, missing: 0 },
    ],
  });
  assert.deepEqual(missing, {
    state: "missing-items",
    status: "缺少材料",
    missing: "红玫瑰(3/1)、黄玫瑰(1/0)",
  });

  const rejected = buildSpecialOrderCategoryView({
    exists: true,
    status: "server-confirmed-out-of-stock",
    statusText: "服务端确认缺货",
    requirements: [
      { itemId: 23015, name: "黄玫瑰", need: 1, have: 80, missing: 0 },
    ],
    stockRejection: { itemId: 23015, need: 1, observedHave: 80, exactHaveKnown: false },
  });
  assert.deepEqual(rejected, {
    state: "server-confirmed-out-of-stock",
    status: "服务端确认缺货",
    missing: "黄玫瑰(需1/本地可见80，非精确)",
  });

  const app = await readFile("work/system/public/app.js", "utf8");
  assert.match(app, /import \{ buildSpecialOrderCategoryView \} from "\.\/special-order-view\.js"/);
  assert.match(app, /const satinView = buildSpecialOrderCategoryView\(satin\)/);
  assert.match(app, /const materialView = buildSpecialOrderCategoryView\(decorate\)/);
  assert.match(app, /satinMissing:\s*satinView\.missing/);
  assert.match(app, /materialMissing:\s*materialView\.missing/);
});

test("system UI v2 settings boundary covers all 16 controls without the legacy snapshot path", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  for (const [key, controlId] of Object.entries(canonicalSettingsControls)) {
    assert.match(app, new RegExp(`${key}: \\\"${controlId}\\\"`));
  }
  assert.match(app, /body: JSON\.stringify\(effect\.patch\)/);
  assert.match(app, /"if-match": effect\.ifMatch/);
  assert.match(app, /"x-xjskp-settings-transaction-id": effect\.transactionId/);
  assert.match(app, /profileSettingsClient\.applyProfilesResponse\(profilesData\)/);
  assert.match(app, /profileSettingsClient\.getEffectiveSettings\(profileId\)/);
  assert.doesNotMatch(app, /beginProfileSettingsUpdate|rollbackProfileSettingsUpdate|requestSettings/);
});

test("settings transaction actions stay above scrollable queue cards", async () => {
  const styles = await readFile("work/system/public/styles.css", "utf8");
  const transactionPanelRule = styles.match(/\.settings-transaction-panel\s*\{([^}]*)\}/)?.[1] || "";
  assert.match(transactionPanelRule, /position:\s*relative/);
  assert.match(transactionPanelRule, /z-index:\s*1/);
});

test("system UI wires waterwheel parent and child switches to saved profile settings", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const builder = app.slice(
    app.indexOf("function buildWaterwheelQueueView"),
    app.indexOf("function buildSatinMaterialQueueView"),
  );
  const changeHandler = app.slice(
    app.indexOf('document.addEventListener("change"'),
    app.indexOf("await guardedRefreshAll"),
  );
  const controlMapping = app.slice(
    app.indexOf("const PROFILE_SETTINGS_CONTROL_IDS"),
    app.indexOf("const profileSettingsClient"),
  );

  assert.match(
    builder,
    /const bucketReceiveEnabled\s*=\s*profile\?\.settings\?\.autoReceiveWaterwheelBuckets\s*!==\s*false/,
  );
  assert.match(
    builder,
    /const videoBucketSkipEnabled\s*=\s*profile\?\.settings\?\.skipWaterwheelVideoBuckets\s*===\s*true/,
  );
  assert.match(builder, /bucketReceiveEnabled,/);
  assert.match(builder, /bucketReceiveDisabled:\s*!profile/);
  assert.match(builder, /bucketReceiveEnabledText:\s*bucketReceiveEnabled\s*\?\s*"开启"\s*:\s*"关闭"/);
  assert.match(builder, /videoBucketSkipEnabled,/);
  assert.match(builder, /videoBucketSkipDisabled:\s*!profile\s*\|\|\s*!bucketReceiveEnabled/);
  assert.doesNotMatch(
    builder,
    /(?:bucketReceiveEnabled|videoBucketSkipEnabled)\s*=.*(?:configured|effective)(?:AutoReceive|SkipVideoBuckets)/s,
  );

  assert.match(changeHandler, /event\.target\?\.id === "waterwheelBucketReceiveToggle"/);
  assert.match(
    changeHandler,
    /updateProfileSettings\(\s*\{\s*autoReceiveWaterwheelBuckets:\s*event\.target\.checked\s*\}/s,
  );
  assert.match(changeHandler, /event\.target\?\.id === "waterwheelVideoBucketSkipToggle"/);
  assert.match(
    changeHandler,
    /updateProfileSettings\(\s*\{\s*skipWaterwheelVideoBuckets:\s*event\.target\.checked\s*\}/s,
  );
  assert.match(
    controlMapping,
    /autoReceiveWaterwheelBuckets:\s*"waterwheelBucketReceiveToggle"/,
  );
  assert.match(
    controlMapping,
    /skipWaterwheelVideoBuckets:\s*"waterwheelVideoBucketSkipToggle"/,
  );
  assert.match(app, /profileSettingsClient\.enqueue\(profileId, nextSettings/);
  assert.doesNotMatch(app, /beginProfileSettingsUpdate|rollbackProfileSettingsUpdate/);
});

test("system UI renders flower rack target from the current profile and ignores stale save responses", async () => {
  const [app, queueView, index] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/index.html", "utf8"),
  ]);

  assert.match(app, /QUEUE_MODULE_GROUPS/);
  assert.match(index, /data-queue-tab/);
  assert.match(queueView, /function createFlowerRackCard\(/);
  assert.match(queueView, /function patchFlowerRackCard\(/);
  assert.match(app, /profile\?\.settings\?\.flowerRackTargetArtId/);
  assert.match(queueView, /flowerRackTargetSelect/);
  assert.match(app, /updateProfileSettings\(\s*\{\s*flowerRackTargetArtId/s);
  assert.match(app, /const profileId = profile\.id/);
  assert.match(app, /state\.selectedProfileId !== profileId/);
});

test("flower rack dropdown is built from current account recommendations without fixed business options", async () => {
  const [app, queueView] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
  ]);
  const flowerRackBuilder = app.slice(
    app.indexOf("function buildFlowerRackQueueView"),
    app.indexOf("function buildPearlQueueView"),
  );

  assert.doesNotMatch(app, /FLOWER_RACK_TARGET_OPTIONS/);
  assert.doesNotMatch(app, /藤韵花篮 \(305101\)|丹青瓷瓶 \(301722\)/);
  assert.match(flowerRackBuilder, /state\.gardenData\?\.flowerRack/);
  assert.match(flowerRackBuilder, /recommendedArts/);
  assert.match(flowerRackBuilder, /targetArt/);
  assert.match(flowerRackBuilder, /flowerRackTargetArtId/);
  assert.match(queueView, /patchFlowerRackOptions/);
  assert.match(queueView, /view\.options/);
});

test("flower rack frontend formats Chinese four-digit units without duplicated zeroes", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const source = app.slice(
    app.indexOf("function formatChineseInteger"),
    app.indexOf("function buildPearlQueueView"),
  ).trim();
  const formatChineseInteger = vm.runInNewContext(`(${source})`);

  assert.equal(formatChineseInteger(100000001), "1亿零1");
  assert.equal(formatChineseInteger(100001000), "1亿零1000");
  assert.equal(formatChineseInteger(100010001), "1亿零1万零1");
});

test("system UI renders and validates per-profile pearl hire item reserve", async () => {
  const [app, queueView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(queueView, /function createPearlCard\(/);
  assert.match(queueView, /function patchPearlCard\(/);
  assert.match(app, /pearlHireItemReserveCount/);
  assert.match(queueView, /pearlHireItemReserveInput/);
  assert.match(app, /Number\.isSafeInteger/);
  assert.match(app, /event\.target\.value\.trim\(\)/);
  assert.match(queueView, /珍珠雇佣卡保留量/);
  assert.match(queueView, /min:\s*"0"/);
  assert.match(queueView, /step:\s*"1"/);
  assert.match(styles, /\.queue-switch input\[type="number"\]/);
});

test("system UI renders an account-scoped 49/99 release switch with inverted persistence and repeatable confirmation", async () => {
  const [app, queueView, index] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/index.html", "utf8"),
  ]);

  assert.match(index, /id="teamOrderProtectionControl"/);
  assert.match(app, /teamOrderTriggerProtectionEnabled/);
  assert.match(queueView, /teamOrderProtectionToggle/);
  assert.match(queueView, /49\/99 组团触发放行/);
  assert.match(app, /const teamOrderTriggerReleaseEnabled = event\.target\.checked/);
  assert.match(app, /const teamOrderTriggerProtectionEnabled = !teamOrderTriggerReleaseEnabled/);
  assert.match(app, /const confirmationMessage = "开启 49\/99 组团触发放行/);
  assert.match(app, /reconfirm: teamOrderTriggerReleaseEnabled/);
  assert.match(
    app,
    /updateProfileSettings\(\s*\{\s*teamOrderTriggerProtectionEnabled/s,
  );
  assert.doesNotMatch(app, /rollbackProfileSettingsUpdate/);
});

test("system UI renders account-scoped yuanbao renewal release with inverted persistence and repeatable paid confirmation", async () => {
  const [app, queueView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(app, /teamOrderPaidRenewProtectionEnabled/);
  assert.match(queueView, /teamOrderPaidRenewProtectionToggle/);
  assert.match(queueView, /元宝续次数放行/);
  assert.match(
    app,
    /profile\?\.settings\?\.teamOrderPaidRenewProtectionEnabled === false/,
  );
  assert.match(app, /const teamOrderPaidRenewReleaseEnabled = event\.target\.checked/);
  assert.match(app, /const teamOrderPaidRenewProtectionEnabled = !teamOrderPaidRenewReleaseEnabled/);
  assert.match(queueView, /未放行：不会自动消费元宝续次数/);
  assert.match(queueView, /已放行；当前每个自然触发的组团最多消费 60 元宝续开 1 次/);
  assert.match(
    app,
    /const confirmationMessage = "开启元宝续次数放行？这是按自然触发持续生效的付费授权；当前每次最多消费 60 元宝续开 1 次。每天可能在第 50\/100 单触发两次，若都有续开机会，当日最多可能消费 120 元宝。"/,
  );
  assert.match(
    app,
    /updateProfileSettings\(\s*\{\s*teamOrderPaidRenewProtectionEnabled/s,
  );
  assert.match(app, /reconfirm: teamOrderPaidRenewReleaseEnabled/);
  assert.doesNotMatch(app, /rollbackProfileSettingsUpdate/);
  assert.match(
    styles,
    /\.team-order-protection-control\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    styles,
    /@media \(max-width:\s*720px\)[\s\S]*?\.team-order-protection-control\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
});

test("system UI exposes usable material shop time and inclusive yuanbao threshold controls", async () => {
  const [app, queueView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(queueView, /function createMaterialShopCard\(/);
  assert.match(queueView, /function patchMaterialShopCard\(/);
  assert.match(queueView, /materialShopMidnightRefreshToggle/);
  assert.match(queueView, /materialShopRefreshWindowStartInput/);
  assert.match(queueView, /materialShopRefreshMaxCostSelect/);
  assert.match(app, /materialShopMidnightRefreshEnabled/);
  assert.match(app, /materialShopRefreshWindowStart/);
  assert.match(app, /materialShopRefreshMaxCostYuanbao/);
  assert.match(app, /\[0, 1, 2, 4, 8, 12, 16\]/);
  assert.match(app, /包含所选值/);
  assert.match(styles, /\.queue-switch input\[type="time"\][\s\S]*?width:\s*112px/s);
  assert.match(styles, /\.queue-switch select[\s\S]*?height:\s*32px/s);
  assert.match(styles, /\.queue-matrix\s*{[^}]*grid-auto-rows:\s*max-content/s);
  assert.match(
    app,
    /updateProfileSettings\(\s*\{\s*materialShopMidnightRefreshEnabled/s,
  );
  assert.match(
    app,
    /updateProfileSettings\(\s*\{\s*materialShopRefreshMaxCostYuanbao/s,
  );
});

test("system UI renders a seven-day completed team-order grid without archive pagination", async () => {
  const [app, archiveView, index, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/team-order-archive-view.js", "utf8"),
    readFile("work/system/public/index.html", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(app, /getRecentCompletedTeamOrderGroups/);
  assert.match(app, /fetchRecentTeamOrders/);
  assert.match(app, /TEAM_ORDER_FETCH_PAGE_SIZE = 50/);
  assert.match(app, /teamOrderArchive\.render\(/);
  assert.match(app, /buildTeamOrderArchiveItemView/);
  assert.match(app, /submittedCount/);
  assert.match(app, /refreshedCount/);
  assert.match(app, /skippedCount/);
  assert.match(app, /displayedReward\[2\]/);
  assert.match(app, /displayedReward\[11\]/);
  assert.match(archiveView, /team-order-card-metric-row", "actions/);
  assert.match(archiveView, /team-order-card-metric-row", "rewards/);
  assert.match(archiveView, /encodeURIComponent\(profileId\)/);
  assert.match(archiveView, /createTextLeaf\(document, "a", "详情"/);
  assert.doesNotMatch(archiveView, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.doesNotMatch(index, /teamOrderCurrent|teamOrderRecent/);
  assert.doesNotMatch(index, /teamOrderPrevButton|teamOrderNextButton/);
  assert.match(styles, /\.team-order-day-grid\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /\.team-order-day-grid\s*{[^}]*align-items:\s*start/s);
  assert.doesNotMatch(styles, /\.team-order-archive-item\s*{[^}]*min-height:/s);
  assert.match(styles, /\.team-order-card-metric-row\.actions\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /\.team-order-card-metric-row\.rewards\s*{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /\.team-order-card-metric-row\s*{[^}]*width:\s*100%[^}]*gap:\s*8px/s);
  assert.match(styles, /\.team-order-card-metric-row\s*>\s*span\s*{[^}]*justify-content:\s*flex-start/s);
});

test("system UI bootstraps a local session token and retries one invalid token response", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /let localSessionToken = null/);
  assert.match(app, /async function getLocalSessionToken\(force = false\)/);
  assert.match(app, /fetch\("\/api\/session", \{ cache: "no-store" \}\)/);
  assert.match(app, /x-xjskp-session-token/);
  assert.match(app, /attempt === 0/);
  assert.match(app, /api\(path, options, 1\)/);
  assert.doesNotMatch(app, /api\(path, options, attempt \+ 1\)/);
});

test("system UI shows server before level, formats progress, and avoids duplicated flower rack notes", async () => {
  const [app, queueView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(app, /serverText/);
  assert.match(app, /formatAccountLevelProgress/);
  assert.match(app, /formatWanNumber/);
  const flowerRackBuilder = app.slice(
    app.indexOf("function buildFlowerRackQueueView"),
    app.indexOf("function buildPearlQueueView"),
  );
  assert.match(flowerRackBuilder, /rule:\s*row\?\.rule \|\| selectedOption\.description/);
  assert.match(queueView, /setTextIfChanged\(record\.rule, view\.rule \|\| ""\)/);
  assert.doesNotMatch(flowerRackBuilder, /shortenRule\(row\.rule\)/);
});

test("system UI formats every status resource count with four-digit comma groups", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  for (const field of [
    "goldText",
    "pearlText",
    "flowerShopCoinText",
    "satinSilkText",
    "buildingMaterialText",
    "yuanbaoText",
    "hireItemCountText",
  ]) {
    assert.match(app, new RegExp(`formatWanNumber\\(summary\\?\\.resources\\?\\.${field}\\)`));
  }
  assert.match(app, /hireItemCount:\s*formatWanNumber\(summary\?\.resources\?\.hireItemCountText\)/);
});

test("system UI keeps all common automation monitor cards in the desktop grid", async () => {
  const [app, queueView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  for (const label of [
    "经验保护",
    "水车水滴",
    "挑水工水滴",
    "土地补种",
    "主线任务",
    "普通居民订单",
    "丝绸建材",
  ]) {
    assert.match(app, new RegExp(`common:[\\s\\S]*\\{ label: "${label}"`));
    assert.match(queueView, new RegExp(label));
  }
  assert.match(queueView, /function createCommonCards\(/);
  assert.match(styles, /\.queue-matrix \.queue-card\s*\{\s*grid-column:\s*span 3;/);
  assert.doesNotMatch(styles, /\.queue-matrix-common \.queue-layout-common-4,[\s\S]*?grid-column:\s*span 6;/);
  assert.doesNotMatch(styles, /\.queue-matrix-secondary \.queue-layout-secondary-5\s*\{[\s\S]*?grid-column:\s*span (?:6|8);/);
});

test("customer order monitor is a common-page dedicated card with account-scoped exact release controls", async () => {
  const [app, queueView, projection, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/status-projection.mjs", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);
  assert.match(app, /common:[\s\S]*顾客订单/);
  assert.match(app, /customer:\s*buildCustomerOrderQueueView\(/);
  assert.match(app, /customerOrderFlowerCurrencyRewardReleaseMask/);
  assert.match(app, /getEffectiveSettings\(profileId\)/);
  assert.match(app, /customerOrderReward[123]Toggle/);
  assert.match(queueView, /function createCustomerOrderCard\(/);
  assert.match(queueView, /function patchCustomerOrderCard\(/);
  assert.match(queueView, /今日完成/);
  assert.match(queueView, /花坊币收益放行/);
  assert.match(projection, /customerOrders:\s*garden\.customerOrders/);
  assert.doesNotMatch(app, /secondary:\s*\[[^\]]*顾客订单/);
  assert.doesNotMatch(styles, /history.*highest|历史最高收益门槛/);
});

test("system UI renders and queues the account experience guard percentage through the v2 transaction client", async () => {
  const [app, queueView, guardView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/experience-guard-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(app, /setInterval\(\(\) => guardedRefreshLive\(\{\s*silent:\s*true\s*\}\)\.catch\(\(\) => \{\}\),\s*5000\)/);
  assert.match(app, /let refreshInFlight = null/);
  assert.match(app, /if \(refreshInFlight\) return refreshInFlight/);
  assert.match(app, /function currentExperienceGuard\(/);
  assert.match(app, /const canRunNow = canOperate && !currentRun && Boolean\(profile\?\.serverIdx\)/);
  assert.match(app, /const canRunOnceNow = canOperate && !currentRun && Boolean\(profile\?\.serverIdx\)/);
  assert.doesNotMatch(app, /const canRun(?:Once)?Now = [^\n]*!experienceGuardBlocked/);
  assert.match(app, /const canRunOrdersNow = canOperate && !currentRun && Boolean\(profile\?\.serverIdx\)/);
  assert.match(app, /ordersDisabled:\s*actionPending \|\| !canRunOrdersNow/);
  assert.match(app, /experience-guard/);
  assert.match(app, /经验保护/);
  assert.match(app, /experienceGuardThresholdPercent/);
  assert.match(queueView, /experienceGuardThresholdInput/);
  assert.equal((queueView.match(/"experienceGuardThresholdInput"/g) || []).length, 1);
  assert.match(queueView, /function createExperienceGuardCard\(/);
  assert.match(queueView, /function patchExperienceGuardCard\(/);
  assert.match(app, /\{ label: "经验保护"/);
  assert.match(app, /experienceGuard:\s*buildExperienceGuardQueueView\(/);
  assert.match(queueView, /patchVisibility\(common, activeTab === "common"\)/);
  assert.match(queueView, /patchCommon\(common, view\.common, document, renderOptions\)/);
  assert.match(app, /parseExperienceGuardThresholdPercentInput/);
  assert.match(app, /formatExperienceGuardThresholdPercent/);
  assert.match(
    app,
    /updateProfileSettings\(\s*\{\s*experienceGuardThresholdPercent/s,
  );
  assert.match(app, /getProfileSettingsControlState\([\s\S]*?"experienceGuardThresholdPercent"/s);
  assert.doesNotMatch(app, /rollbackProfileSettingsUpdate/);
  assert.doesNotMatch(app, /experienceGuardSettingsPendingProfileId/);
  assert.match(app, /control\.dataset\.settingsTransactionState = transactionView\.status/);
  assert.match(app, /queueControlDrafts/);
  assert.match(queueView, /dirty && document\.activeElement === control && !force/);
  assert.match(app, /function handleProfileSettingsChange\(\{ profileId, changedKeys = \[\] \}\)/);
  assert.match(app, /forceControlIds: getControlIdsForSettingKeys\(changedKeys\)/);
  assert.doesNotMatch(app, /forceControlIds: getControlIdsForSettings\(effectiveSettings \|\| \{\}\)/);
  const updateSettings = app.slice(
    app.indexOf("async function updateProfileSettings"),
    app.indexOf("async function closeSystem"),
  );
  assert.match(updateSettings, /profileSettingsClient\.enqueue\(profileId, nextSettings/);
  assert.doesNotMatch(updateSettings, /beginProfileSettingsUpdate|rollbackProfileSettingsUpdate|requestSettings/);
  assert.doesNotMatch(app, /\["0\.5%经验保护门槛"/);
  assert.match(guardView, /有经验动作暂停，无经验动作继续/);
  assert.doesNotMatch(app, /固定\s*2000/);
  assert.match(styles, /\.experience-guard-panel/);
  assert.match(styles, /\.experience-guard-panel\.blocked/);
  assert.match(styles, /\.experience-guard-percent-control/);
  assert.match(styles, /\.experience-guard-queue-card \.experience-guard-panel/);
  assert.match(styles, /\.queue-matrix\s*>\s*\.queue-empty\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s);
});

test("system UI default polling uses the compact projection and does not fetch logs separately", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /gardenData: status\.projection\?\.garden \|\| null/);
  assert.match(app, /orderData: status\.projection\?\.order \|\| null/);
  assert.match(app, /logs: \[\]/);
  const liveRefresh = app.slice(
    app.indexOf("async function refreshLive"),
    app.indexOf("async function loadProfileStatus"),
  );
  assert.doesNotMatch(liveRefresh, /fetchProfileStatus|\/status/);
  assert.doesNotMatch(app, /api\(`\/api\/profiles\/\$\{encodeURIComponent\(profileId\)\}\/logs`\)/);
});

test("system UI keeps per-profile run badges without bulk controls", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const collections = await readFile("work/system/public/keyed-collections-view.js", "utf8");
  const index = await readFile("work/system/public/index.html", "utf8");
  const styles = await readFile("work/system/public/styles.css", "utf8");

  assert.doesNotMatch(app, /selectedProfileIds/);
  assert.doesNotMatch(index, /id="bulkStartButton"/);
  assert.doesNotMatch(index, /id="bulkStopButton"/);
  assert.doesNotMatch(index, /id="stopAllButton"/);
  assert.doesNotMatch(index, /id="bulkRunText"/);
  assert.doesNotMatch(app, /api\("\/api\/profiles\/bulk\/start"/);
  assert.doesNotMatch(app, /api\("\/api\/profiles\/bulk\/stop"/);
  assert.match(app, /function getProfileRun\(/);
  assert.match(app, /function getProfileLastExit\(/);
  assert.match(app, /function getProfileRunBadge\(/);
  assert.doesNotMatch(app, /data-profile-checkbox/);
  assert.match(collections, /profile-run-badge/);
  assert.match(collections, /createTextLeaf\(document,\s*"span",\s*"",\s*"run-pid"\)/);
  assert.match(collections, /createTextLeaf\(document,\s*"span",\s*"",\s*"run-mode"\)/);
  assert.match(collections, /createTextLeaf\(document,\s*"span",\s*"",\s*"run-started-at"\)/);
  assert.match(app, /activeByProfile/);
  assert.match(app, /currentProfileRun/);
  assert.doesNotMatch(app, /legacyConflict/);
  assert.match(app, /const canOperate = Boolean\(profile\?\.hasCredentials\)/);
  assert.match(app, /const canRunNow = canOperate && !currentRun/);
  assert.match(app, /const canRunOnceNow = canOperate && !currentRun/);
  assert.doesNotMatch(styles, /\.bulk-actions/);
  assert.match(styles, /\.profile-card\.running/);
  assert.match(styles, /\.profile-run-badge/);
});

test("system UI treats old status as stale after a newer task start or exit", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /function getCurrentStatusStaleInfo\(/);
  assert.match(app, /function parseStatusTime\(/);
  assert.match(app, /最近状态早于本次启动\/退出，查看日志/);
  assert.match(app, /const staleStatus = getCurrentStatusStaleInfo\(\)/);
  assert.match(app, /!getCurrentStatusStaleInfo\(\)\s*&&\s*stopped\?\.reason === "session-expired"/s);
});

test("system UI keeps cyclic-note queue label out of fixed module groups", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.doesNotMatch(app, /common:\s*\[[\s\S]*?label:\s*["']花笺集芳["'][\s\S]*?\]/);
  assert.doesNotMatch(app, /secondary:\s*\[[\s\S]*?label:\s*["']花笺集芳["'][\s\S]*?\]/);
});

test("system UI builds the fixed queue dashboard through the area lookup helper", async () => {
  const [app, queueView] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
  ]);

  assert.match(app, /function buildQueueDashboardView\(/);
  assert.match(app, /const module = \(group, index\) => findQueueRow\(byArea, QUEUE_MODULE_GROUPS\[group\]\[index\]\)/);
  assert.match(app, /common:\s*\{[\s\S]*waterwheel:[\s\S]*mainTask:/s);
  assert.match(app, /secondary:\s*\{[\s\S]*palace:[\s\S]*materialShop:/s);
  assert.match(app, /queueDashboard\.render\(view/);
  assert.match(queueView, /noteStyle \? "p" : "em"/);
  assert.match(queueView, /"flower-rack"[\s\S]*rule: "note"/s);
});

test("system UI does not rebuild team archives during unrelated queue tab updates", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const renderQueue = app.slice(
    app.indexOf("function renderQueue("),
    app.indexOf("function buildQueueDashboardView("),
  );
  const renderAll = app.slice(
    app.indexOf("function renderAll("),
    app.indexOf("function renderRuntime("),
  );

  assert.doesNotMatch(renderQueue, /renderTeamOrders\(/);
  assert.equal((renderAll.match(/renderTeamOrders\(/g) || []).length, 1);
  assert.match(app, /if \(nextTab === "team-orders"\) \{[\s\S]*renderTeamOrders\(\);[\s\S]*loadCurrentProfileTeamOrders/s);
});

test("system UI includes cyclic note queue renderer hook", async () => {
  const [app, collectionsView] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-collections-view.js", "utf8"),
  ]);

  assert.match(app, /function buildCyclicNoteQueueView\(/);
  assert.match(app, /queueCollections\.renderCyclicNote\(/);
  assert.match(collectionsView, /function createCyclicNoteCard\(/);
  assert.match(collectionsView, /data-cyclic-note-task-key/);
});

test("system UI keeps cyclic story in its named tab with three concise submission panels", async () => {
  const [app, queueView, cyclicView] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
    readFile("work/system/public/cyclic-story-view.js", "utf8"),
  ]);

  assert.match(app, /activities:\s*\[[\s\S]*area:\s*"莳花纪闻"[\s\S]*\]/s);
  assert.doesNotMatch(app, /function shouldShowCyclicStoryQueueCard\(/);
  assert.match(app, /cyclicStory:\s*buildCyclicStoryView\(cyclicStoryRow, state\.gardenData\?\.cyclicStory,\s*\{[\s\S]*autoSubmitEnabled[\s\S]*onlyHighestExperienceEnabled[\s\S]*hasProfile[\s\S]*\}\)/);
  assert.match(queueView, /createCyclicStoryRenderer\(document, "queue-layout-activities-1"\)/);
  assert.match(cyclicView, /const SLOT_COUNT = 3/);
  assert.match(cyclicView, /const ACTIVE_PHASE = 2/);
  assert.match(cyclicView, /Array\.from\(\{ length: SLOT_COUNT \}/);
  assert.match(cyclicView, /`提交面板 \$\{slotNo\}`/);
  assert.match(cyclicView, /预告期（阶段1）/);
  assert.match(cyclicView, /活动尚未开始；进入阶段2后刷新订单/);
  assert.match(cyclicView, /兑换期（阶段3）/);
  assert.match(cyclicView, /function formatRemaining\(/);
  assert.match(cyclicView, /Math\.ceil\(Number\(value\) \/ 1_000\)/);
  assert.match(cyclicView, /padStart\(2, "0"\)/);
  for (const copy of ["冷却", "规则：仅阶段2；冷却结束且库存充足时提交；每轮最多3单，不刷新/付费", "只做最高经验订单", "任一单冷却时整轮等待", "花朵 ID", "本单只消耗这一种花", "需求/库存", "残页", "经验", "金币"]) {
    assert.match(cyclicView, new RegExp(copy.replace("/", "\\/")));
  }
  assert.doesNotMatch(cyclicView, /innerHTML|outerHTML|replaceChildren/);
});

test("system UI wires cyclic story auto submit toggle to profile settings", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /event\.target\?\.id === "cyclicStoryAutoSubmitToggle"/);
  assert.match(app, /updateProfileSettings\(\s*\{\s*autoSubmitCyclicStoryOrders:\s*event\.target\.checked\s*\},\s*\{\s*successMessage/);
  assert.match(app, /autoSubmitCyclicStoryOrders:\s*"cyclicStoryAutoSubmitToggle"/);
  const changeHandler = app.match(/document\.addEventListener\("change", \(event\) => \{([\s\S]*?)\n\}\);/u)?.[1] || "";
  assert.match(changeHandler, /event\.target\?\.id === "cyclicStoryAutoSubmitToggle"/);
});

test("system UI wires cyclic story highest experience toggle to profile settings", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /event\.target\?\.id === "cyclicStoryOnlyHighestExperienceToggle"/);
  assert.match(app, /updateProfileSettings\(\s*\{\s*cyclicStoryOnlyHighestExperienceOrder:\s*event\.target\.checked\s*\},\s*\{\s*successMessage/);
  assert.match(app, /cyclicStoryOnlyHighestExperienceOrder:\s*"cyclicStoryOnlyHighestExperienceToggle"/);
  const changeHandler = app.match(/document\.addEventListener\("change", \(event\) => \{([\s\S]*?)\n\}\);/u)?.[1] || "";
  assert.match(changeHandler, /event\.target\?\.id === "cyclicStoryOnlyHighestExperienceToggle"/);
});

test("system UI keeps cyclic story highest experience as a child of auto submit", async () => {
  const [app, cyclicView, styles] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/cyclic-story-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(app, /key === "cyclicStoryOnlyHighestExperienceOrder"/);
  assert.match(app, /profile\?\.settings\?\.autoSubmitCyclicStoryOrders === false/);
  assert.match(cyclicView, /onlyHighestExperienceDisabled: !options\?\.hasProfile \|\| !autoSubmitEnabled/);
  assert.match(cyclicView, /任一当前订单冷却时整轮等待；最高经验单缺库存不降级/);
  assert.match(styles, /\.cyclic-story-highest-experience-switch\s*\{(?=[^}]*margin-left:\s*16px)(?=[^}]*min-width:\s*0)[^}]*\}/s);
  assert.match(styles, /\.cyclic-story-highest-experience-switch\s*>\s*span\s*\{(?=[^}]*display:\s*grid)(?=[^}]*gap:\s*2px)[^}]*\}/s);
});

test("system UI projects the cyclic-note card for every normal status snapshot", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const visibilitySource = app.slice(
    app.indexOf("function shouldShowCyclicNoteQueueCard"),
    app.indexOf("function getExperienceGuardStopInfo"),
  );
  const phaseOneExistingState = {
    status: { ok: true },
    gardenData: {
      cyclicNote: {
        exists: true,
        phase: 1,
        active: false,
        score: 35,
        scoreLimit: 80,
        phaseEndMs: 2,
        phaseRemainingMs: 60_000,
        timeTrusted: true,
        taskSlots: [{ slotIndex: 1 }, { slotIndex: 2 }, { slotIndex: 3 }],
      },
    },
  };

  assert.match(app, /function shouldShowCyclicNoteQueueCard\(/);
  assert.match(app, /const cyclicNote = state\.gardenData\?\.cyclicNote/);
  assert.match(app, /const statusOk = state\.status\?\.ok === true/);
  assert.match(app, /return statusOk \|\| cyclicNote\?\.active === true \|\| byArea\.has\("花笺集芳"\)/);
  assert.match(app, /cyclicNote\?\.active/);
  assert.match(app, /(byArea\.has\(\s*["']花笺集芳["']\s*\)|area\s*={1,3}\s*["']花笺集芳["'])/);
  assert.equal(vm.runInNewContext(
    `${visibilitySource}; shouldShowCyclicNoteQueueCard(new Map())`,
    { state: phaseOneExistingState },
  ), true);
  assert.equal(vm.runInNewContext(
    `${visibilitySource}; shouldShowCyclicNoteQueueCard(new Map())`,
    { state: { ...phaseOneExistingState, status: { ok: false } } },
  ), false);
});

test("system UI keeps a phase-one existing cyclic note with three slots visible", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const builderSource = app.slice(
    app.indexOf("function buildCyclicNoteQueueView"),
    app.indexOf("function buildOrdinaryResidentSlotsView"),
  );
  const phaseOneExistingState = {
    status: { ok: true },
    gardenData: {
      cyclicNote: {
        exists: true,
        phase: 1,
        active: false,
        score: 35,
        scoreLimit: 80,
        phaseEndMs: 2,
        phaseRemainingMs: 60_000,
        timeTrusted: true,
        taskSlots: [{ slotIndex: 1 }, { slotIndex: 2 }, { slotIndex: 3 }],
      },
    },
  };

  assert.match(app, /const cyclicNote = row\?\.cyclicNote \|\| state\.gardenData\?\.cyclicNote \|\| \{\}/);
  assert.match(app, /const taskSlots = Array\.isArray\(cyclicNote\.taskSlots\) \? cyclicNote\.taskSlots : \[\]/);
  assert.match(app, /Array\.from\(\{ length: 3 \}, \(_, index\) => taskSlots\[index\] \|\| \(/);
  assert.match(app, /const phaseText = cyclicNote\.phaseText \|\| cyclicNotePhaseText\(cyclicNote\.phase\)/);
  assert.match(app, /\? formatPhaseRemaining\(cyclicNote\.phaseRemainingMs\)\s*:\s*"--:--"/);
  const view = vm.runInNewContext(`${builderSource}; buildCyclicNoteQueueView(null)`, {
    state: phaseOneExistingState,
    currentProfile: () => null,
    canMutateProfileSettings: () => false,
    valueOrDash: (value) => value == null ? "-" : String(value),
    formatPair: (current, total) => total == null ? String(current) : `${current}/${total}`,
    formatPhaseRemaining: () => "0天00时01分00秒",
  });
  assert.deepEqual(Array.from(view.tasks, (task) => task.slotIndex), [1, 2, 3]);
  assert.equal(view.phase, "预告期（阶段1）");
  assert.equal(view.phaseRemaining, "0天00时01分00秒");
  assert.equal(view.score, "35/80");
  const untrustedView = vm.runInNewContext(`${builderSource}; buildCyclicNoteQueueView(null)`, {
    state: {
      ...phaseOneExistingState,
      gardenData: {
        cyclicNote: { ...phaseOneExistingState.gardenData.cyclicNote, timeTrusted: false },
      },
    },
    currentProfile: () => null,
    canMutateProfileSettings: () => false,
    valueOrDash: (value) => value == null ? "-" : String(value),
    formatPair: () => "-",
    formatPhaseRemaining: () => "不应调用",
  });
  assert.equal(untrustedView.phaseRemaining, "--:--");
});

test("system UI does not expose forbidden cyclic-note action names", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const index = await readFile("work/system/public/index.html", "utf8");
  const forbiddenActionNames = [
    "recvTaskRwd",
    "cyclicNoteRecvTaskRwd",
    "cyclicNoteEnter",
    "autoReceiveCyclic",
  ];

  assert.match(index, /data-queue-tab="cyclic-note"/);
  for (const action of forbiddenActionNames) {
    assert.doesNotMatch(app, new RegExp(action));
  }
});

test("system UI disables duplicate task actions and only reports start after an active PID exists", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /pendingAction/);
  assert.match(app, /const actionProfileId = profile\.id/);
  assert.match(app, /getProfileRun\(actionProfileId\)/);
  assert.match(app, /启动失败：会话失效，请先验证账号/);
  assert.match(app, /启动失败：未检测到运行中的任务/);
  assert.match(app, /Number\(result\?\.exitCode \?\? 0\) !== 0/);
  assert.doesNotMatch(app, /start:\s*"循环已启动。"/);
});

test("system UI guards refresh generations so stale polling cannot overwrite action state", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /let refreshGeneration = 0/);
  assert.match(app, /function beginRefreshGeneration\(/);
  assert.match(app, /function isCurrentRefreshGeneration\(/);
  assert.match(app, /const snapshot = \{/);
  assert.match(app, /if \(!isCurrentRefreshGeneration\(generation\)\) return false/);
  assert.match(app, /Object\.assign\(state, snapshot\)/);
});

test("system UI separates successful action posts from post-action refresh failures", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /async function refreshAfterAction\(/);
  assert.match(app, /操作已提交，但状态刷新失败/);
  assert.match(app, /const refreshOk = await refreshAfterAction\(\)/);
  assert.match(app, /showToast\(refreshOk \? "验证账号通过，已更新最近验证时间。" : "验证账号已提交成功，状态刷新失败，请稍后刷新。"\)/);
});

test("system UI polls after start until the same profile is active or a same-start exit appears", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.match(app, /async function waitForStartOutcome\(/);
  assert.match(app, /const START_CONFIRM_POLL_ATTEMPTS = 8/);
  assert.match(app, /const START_CONFIRM_POLL_INTERVAL_MS = 500/);
  assert.match(app, /lastExit\?\.startedAt === result\?\.startedAt/);
  assert.match(app, /return \{ state: "running", run \}/);
  assert.match(app, /return \{ state: "exited", lastExit \}/);
});

test("system UI reports validation session expiry as credential refresh instead of another validation", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");
  const collections = await readFile("work/system/public/keyed-collections-view.js", "utf8");

  assert.match(app, /formatValidationErrorMessage/);
  assert.match(app, /验证失败：会话已过期，请重新导入最新凭据/);
  assert.match(app, /state: "expired", label: "会话失效"/);
  assert.match(collections, /expiredDetail = createTextLeaf\(document, "span", "需重导凭据"\)/);
  assert.match(collections, /record\.expiredDetail, "hidden", view\.runState !== "expired"/);
  assert.doesNotMatch(app, /state\.validationError = err\.message \|\| "验证失败，请重新导入凭据。"/);
});

test("system UI explicitly rearms the selected account with fresh revision and never auto-retries conflicts", async () => {
  const [app, queueView] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
  ]);

  assert.match(queueView, /experienceGuardRearmButton/);
  assert.match(queueView, /onExperienceGuardRearm/);
  assert.match(app, /async function rearmCurrentExperienceGuard\(/);
  assert.match(app, /const actionProfileId = profile\.id/);
  assert.match(app, /api\(`\/api\/profiles\/\$\{encodedProfileId\}\/experience-guard`\)/);
  assert.match(app, /expectedStateRevision:\s*guardState\.stateRevision/);
  assert.match(app, /confirm:\s*true/);
  assert.match(app, /state\.selectedProfileId !== actionProfileId/);
  assert.match(app, /状态已更新，请查看最新状态后重新确认/);
  assert.doesNotMatch(app, /currentStateRevision[\s\S]{0,240}method:\s*"POST"/);
  assert.match(app, /已提交，等待(?:下一次)?实时等级确认/);
  assert.doesNotMatch(app, /重新布防已解除/);
});

test("experience guard rearm click posts the freshly fetched account revision", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [
      refreshRaceExperienceGuard(6),
      refreshRaceExperienceGuard(7),
      refreshRaceExperienceGuard(7, { pending: true }),
    ],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );
  assert.ok(button);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);

  button.click();
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  const posts = harness.requests.filter((request) => (
    request.method === "POST"
    && request.pathname === "/api/profiles/p1/experience-guard"
  ));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, {
    confirm: true,
    expectedStateRevision: 7,
  });
  assert.match(harness.confirmMessages[0], /账号 p1/);
  assert.match(harness.confirmMessages[0], /当前记录：20/);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "等待权威确认");
});

test("experience guard rearm cancellation sends no mutation", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [refreshRaceExperienceGuard(6), refreshRaceExperienceGuard(7)],
    confirmAnswers: [false],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );

  button.click();
  await flushRefreshRaceTasks();

  assert.equal(harness.confirmMessages.length, 1);
  assert.equal(harness.requests.filter((request) => request.method === "POST").length, 0);
});

test("experience guard rearm stays hidden for a non-recoverable invalid state even when breached", async (t) => {
  const guardControl = refreshRaceExperienceGuard(7);
  guardControl.state.invalid = true;
  guardControl.state.invalidReason = "experience-guard-account-identity-mismatch";
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [guardControl],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );

  assert.ok(button);
  assert.equal(button.hidden, true);
  assert.equal(harness.requests.filter((request) => request.method === "POST").length, 0);
});

test("experience guard rearm conflict refreshes state and never retries the mutation", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [
      refreshRaceExperienceGuard(6),
      refreshRaceExperienceGuard(7),
      refreshRaceExperienceGuard(8),
    ],
    guardPostStatus: 409,
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );

  button.click();
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  const posts = harness.requests.filter((request) => (
    request.method === "POST"
    && request.pathname === "/api/profiles/p1/experience-guard"
  ));
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { confirm: true, expectedStateRevision: 7 });
  assert.equal(harness.guardGetCallCount(), 2);
  assert.match(
    harness.document.getElementById("toast").textContent,
    /状态已更新，请查看最新状态后重新确认；系统没有自动重试/,
  );
  assert.equal(button.disabled, false);
});

test("full refresh replaces a stale guard control before rendering the rearm button", async (t) => {
  const normalGuard = refreshRaceExperienceGuard(8, { breached: false });
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [refreshRaceExperienceGuard(7), normalGuard],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );
  assert.equal(button.hidden, false);

  harness.document.getElementById("refreshButton").click();
  await flushRefreshRaceTasks();

  assert.equal(button.hidden, true);
});

test("unresolved settlement is shown as pending reconciliation, not experience defense", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [refreshRaceExperienceGuard(7, {
      invalid: true,
      invalidReason: "experience-guard-settlement-unresolved",
    })],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );

  assert.equal(button.hidden, false);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "待核对未决请求");
});

test("unresolved settlement recovery is account-bound, explicit, and never retries harvest", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [refreshRaceExperienceGuard(7, {
      invalid: true,
      invalidReason: "experience-guard-settlement-unresolved",
      pendingSettlement: {
        requestId: "pending-harvest",
        iface: "gs.usrLand.harvest",
        actionArgs: { landId: 1028 },
        actionEvidence: {
          land: {
            landId: 1028,
            snapshot: { landId: 1028, flowerId: 23001, state: 3, harvestCnt: 1 },
          },
        },
      },
    })],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "确认恢复未决收益");
  button.click();
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  const recoveryPosts = harness.requests.filter((request) => (
    request.method === "POST"
    && request.pathname === "/api/profiles/p1/experience-guard/recover-settlement"
  ));
  assert.equal(recoveryPosts.length, 1);
  assert.deepEqual(recoveryPosts[0].body, {
    confirm: true,
    expectedStateRevision: 7,
    pendingRequestId: "pending-harvest",
  });
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "等待未决结算核对");
  assert.match(
    harness.confirmMessages[0],
    /不会自动重试收获/,
  );
});

test("legacy unresolved settlement exposes a stopped-account manual unlock with an audit reason", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    guardControls: [refreshRaceExperienceGuard(7, {
      invalid: true,
      invalidReason: "experience-guard-settlement-unresolved",
      pendingSettlement: {
        requestId: "pending-harvest",
        iface: "gs.usrLand.harvest",
        actionArgs: { landId: 1028 },
      },
    })],
  });
  const button = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "experienceGuardRearmButton",
  );

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "人工解除历史锁");
  button.click();
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  const resolutionPosts = harness.requests.filter((request) => (
    request.method === "POST"
    && request.pathname === "/api/profiles/p1/experience-guard/resolve-legacy-settlement"
  ));
  assert.equal(resolutionPosts.length, 1);
  assert.deepEqual(resolutionPosts[0].body, {
    confirm: true,
    legacyUnverified: true,
    expectedStateRevision: 7,
    pendingRequestId: "pending-harvest",
    operatorReason: "用户停止后遗留请求缺少执行前快照；人工接受远端可能已执行的不确定性，仅解除当前经验保护锁，不自动重试收益。",
  });
  assert.match(harness.confirmMessages[0], /无法证明请求未发送/);
  assert.match(harness.confirmMessages[0], /不会自动重试收获/);
});

test("5000ms silent polling callback absorbs refresh promise rejection", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [],
    failRuntimeAfterBoot: true,
  });

  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].delay, 5000);
  const polling = harness.intervals[0].callback();
  assert.equal(typeof polling?.then, "function", "the interval callback must expose its handled refresh promise");
  await assert.doesNotReject(() => polling);
});

test("5000ms polling refreshes only runtime", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
  });
  const baselineCount = harness.requests.length;

  await harness.intervals[0].callback();
  const polled = harness.requests.slice(baselineCount).map((request) => request.pathname);

  assert.deepEqual(polled, ["/api/runtime"]);
});

test("steady polling does not request selected profile status", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
  });
  const baselineCount = harness.requests.length;

  await harness.intervals[0].callback();

  assert.deepEqual(
    harness.requests.slice(baselineCount).map((request) => request.pathname),
    ["/api/runtime"],
  );
});

test("console keeps one global light timer and no profile-local status timer", async () => {
  const app = await readFile("work/system/public/app.js", "utf8");

  assert.equal((app.match(/\bsetInterval\(/g) || []).length, 1);
  assert.match(app, /setInterval\(\(\) => guardedRefreshLive\(\{\s*silent:\s*true\s*\}\)\.catch\(\(\) => \{\}\),\s*5000\)/);
  assert.doesNotMatch(app, /setInterval\([\s\S]{0,240}\bprofileId\b/);
});

test("first open and manual refresh carry distinct full-read triggers", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
  });
  const firstOpen = harness.requests.find((request) => request.pathname === "/api/profiles/p1/status");
  assert.match(firstOpen?.search || "", /full=1/);
  assert.match(firstOpen?.search || "", /trigger=first-open/);

  harness.document.getElementById("refreshButton").click();
  await flushRefreshRaceTasks();
  const manualRefresh = harness.requests
    .filter((request) => request.pathname === "/api/profiles/p1/status")
    .at(-1);
  assert.match(manualRefresh?.search || "", /trigger=manual-refresh/);
});

test("account switch performs one full read with the account-switch trigger", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1"), refreshRaceProfile("p2")],
  });
  const p2Card = findRefreshRaceByProfileId(
    harness.document.getElementById("profileItems"),
    "p2",
  );
  assert.ok(p2Card);

  p2Card.click();
  await flushRefreshRaceTasks();

  const p2Reads = harness.requests.filter((request) => (
    request.pathname === "/api/profiles/p2/status"
    && /full=1/.test(request.search)
  ));
  assert.equal(p2Reads.length, 1);
  assert.match(p2Reads[0].search, /trigger=account-switch/);
});

test("runtime transport failure is visible and recovery performs one full read", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    failRuntimeCalls: [2],
  });

  await harness.intervals[0].callback();
  assert.equal(harness.document.getElementById("riskStatusValue").textContent, "状态不再实时");

  await harness.intervals[0].callback();
  await flushRefreshRaceTasks();
  const recoveredReads = harness.requests.filter((request) => (
    request.pathname === "/api/profiles/p1/status"
    && /trigger=browser-reconnect/.test(request.search)
  ));
  assert.equal(recoveredReads.length, 1);

  await harness.intervals[0].callback();
  await flushRefreshRaceTasks();
  assert.equal(
    harness.requests.filter((request) => /trigger=browser-reconnect/.test(request.search)).length,
    1,
  );
});

test("ordinary action refreshes runtime only and does not read profile status", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
  });
  const baselineCount = harness.requests.length;

  harness.document.getElementById("onceButton").click();
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  const actionRequests = harness.requests.slice(baselineCount).map((request) => request.pathname);
  assert.equal(actionRequests.includes("/api/profiles/p1/status"), false);
  assert.equal(actionRequests.includes("/api/runtime"), true);
});

test("start waits for first artifact completion before one first-complete full read", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    startArtifactReadyAfterRuntimeCalls: 4,
    runTimersImmediately: true,
  });
  const baselineCount = harness.requests.length;

  harness.document.getElementById("startButton").click();
  for (let index = 0; index < 8; index += 1) await flushRefreshRaceTasks();

  const statusReads = harness.requests.slice(baselineCount).filter((request) => (
    request.pathname === "/api/profiles/p1/status"
  ));
  assert.equal(statusReads.length, 1);
  assert.match(statusReads[0].search, /full=1/);
  assert.match(statusReads[0].search, /trigger=first-complete/);
});

test("full refresh clears the previous account flower rack when the replacement account status fails", async (t) => {
  const profileA = refreshRaceProfile("p1");
  profileA.settings.flowerRackTargetArtId = 305101;
  const harness = await createRefreshRaceHarness(t, {
    profilesResponses: [[profileA], [refreshRaceProfile("p2")]],
    p1FlowerRack: {
      recommendedArts: [
        { artId: 300307, label: "300307(云纹瓶+红玫瑰)", salePrice: 900, rackGold: 21600 },
      ],
      targetArt: {
        artId: 305101,
        salePrice: 200,
        rackGold: 4800,
        recipe: {
          materials: [
            { kind: "vase", itemName: "青瓷瓶", needPerArt: 1 },
            { kind: "flower", itemName: "红玫瑰", needPerArt: 1 },
          ],
        },
      },
    },
    failP2Status: true,
  });
  const select = findRefreshRaceById(
    harness.document.getElementById("queueMatrix"),
    "flowerRackTargetSelect",
  );
  assert.equal(select.value, "305101");
  assert.deepEqual(
    select.children.map((option) => option.textContent),
    [
      "不自动上架",
      "300307【双倍每架2万1600金币】(云纹瓶+红玫瑰)",
      "305101【双倍每架4800金币】(青瓷瓶+红玫瑰)",
    ],
  );

  harness.document.getElementById("refreshButton").click();
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  assert.equal(select.value, "");
  assert.deepEqual(
    select.children.map((option) => option.textContent),
    ["不自动上架"],
  );
  assert.equal(
    harness.requests.some((request) => request.method === "POST" && request.pathname.endsWith("/settings")),
    false,
  );
});

test("team-order archive loads only after its tab is selected", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    exposeQueueTabs: true,
  });
  assert.equal(harness.requests.some((request) => request.pathname.includes("/team-orders?")), false);

  harness.document.queueTab("team-orders").click();
  await flushRefreshRaceTasks();

  assert.equal(
    harness.requests.filter((request) => request.pathname.includes("/team-orders?")).length,
    1,
  );
});

test("failed profile action schedules a fresh recovery after an invalidated poll is already in flight", async (t) => {
  const harness = await createRefreshRaceHarness(t, {
    profiles: [refreshRaceProfile("p1")],
    holdRuntimeCall: 2,
    failOnceAction: true,
  });
  assert.equal(harness.runtimeCallCount(), 1);

  const stalePollResult = harness.intervals[0].callback();
  await flushRefreshRaceTasks();
  assert.equal(harness.runtimeCallCount(), 2);

  harness.document.getElementById("onceButton").click();
  await flushRefreshRaceTasks();
  harness.releaseHeldRuntime();
  await Promise.resolve(stalePollResult);
  await flushRefreshRaceTasks();
  await flushRefreshRaceTasks();

  assert.equal(
    harness.runtimeCallCount(),
    3,
    "the action failure must issue one new refresh instead of reusing the stale in-flight poll",
  );
});

test("full queue render keeps the cyclic-note child disabled when its parent is off", async (t) => {
  const profile = refreshRaceProfile("p1", {
    autoHandleCyclicNote: false,
    autoCompleteCyclicNoteHighestRewardTask: true,
  });
  const harness = await createRefreshRaceHarness(t, {
    profiles: [profile],
    p1Garden: {
      cyclicNote: {
        active: true,
        phase: 2,
        taskSlots: [],
      },
    },
  });
  const child = harness.document.getElementById("cyclicNoteNaturalCompletionToggle");
  assert.equal(child.checked, true);
  assert.equal(child.disabled, true);
});

async function createRefreshRaceHarness(t, options = {}) {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalConfirm = globalThis.confirm;
  const document = new RefreshRaceDocument();
  const intervals = [];
  const requests = [];
  const confirmMessages = [];
  const confirmAnswers = [...(options.confirmAnswers || [true])];
  const heldRuntime = refreshRaceDeferred();
  let runtimeCalls = 0;
  let profilesCalls = 0;
  let guardGetCalls = 0;
  let startRequested = false;

  if (options.exposeQueueTabs) document.exposeQueueTabs();
  globalThis.document = document;
  globalThis.setInterval = (callback, delay) => {
    intervals.push({ callback, delay });
    return intervals.length;
  };
  globalThis.setTimeout = (callback) => {
    if (options.runTimersImmediately) callback();
    return 0;
  };
  globalThis.clearTimeout = () => {};
  globalThis.confirm = (message) => {
    confirmMessages.push(String(message));
    return confirmAnswers.length ? confirmAnswers.shift() : true;
  };
  globalThis.fetch = async (url, init = {}) => {
    const rawUrl = String(url);
    const [pathname, searchText = ""] = rawUrl.split("?", 2);
    const search = searchText ? `?${searchText}` : "";
    const method = init.method || "GET";
    requests.push({
      pathname: pathname === "/api/profiles/p1/team-orders" ? rawUrl : pathname,
      search,
      method,
      body: init.body ? JSON.parse(init.body) : null,
      headers: { ...(init.headers || {}) },
    });
    if (pathname === "/api/session") {
      return refreshRaceJsonResponse({ token: "test-session" });
    }
    if (pathname === "/api/runtime") {
      runtimeCalls += 1;
      if (options.failRuntimeAfterBoot && runtimeCalls > 1) {
        throw new Error("runtime unavailable");
      }
      if (options.failRuntimeCalls?.includes(runtimeCalls)) {
        throw new Error("runtime unavailable");
      }
      if (runtimeCalls === options.holdRuntimeCall) return heldRuntime.promise;
      return refreshRaceJsonResponse(refreshRaceRuntime({
        startRequested,
        artifactComplete: startRequested
          && runtimeCalls >= Number(options.startArtifactReadyAfterRuntimeCalls || Number.POSITIVE_INFINITY),
      }));
    }
    if (pathname === "/api/profiles") {
      const responses = options.profilesResponses || [options.profiles || []];
      const profiles = responses[Math.min(profilesCalls, responses.length - 1)];
      profilesCalls += 1;
      return refreshRaceJsonResponse({ settingsProtocolVersion: 2, profiles });
    }
    if (pathname === "/api/migration/legacy-credentials") {
      return refreshRaceJsonResponse({ exists: false, complete: false, missingFields: [] });
    }
    if (pathname === "/api/system/game-version") {
      return refreshRaceJsonResponse({ checking: false, comparison: "unknown" });
    }
    if (pathname === "/api/profiles/p1/status") {
      return refreshRaceJsonResponse({
        summary: {
          profileId: "p1",
          risk: {
            experienceGuardBlocked: Boolean(options.guardControls || options.guardControl),
          },
        },
        projection: {
          garden: options.p1Garden || (options.p1FlowerRack ? { flowerRack: options.p1FlowerRack } : null),
          order: null,
        },
        revision: "boot-etag",
      }, 200, { etag: '"boot-etag"' });
    }
    if (pathname === "/api/profiles/p2/status") {
      return options.failP2Status
        ? refreshRaceJsonResponse({ message: "p2 status unavailable" }, 503)
        : refreshRaceJsonResponse({
            summary: { profileId: "p2" },
            projection: { garden: null, order: null },
            revision: "p2-etag",
          }, 200, { etag: '"p2-etag"' });
    }
    if (pathname === "/api/profiles/p1/team-orders" && search === "?page=1&pageSize=50") {
      return refreshRaceJsonResponse({ page: 1, pageSize: 50, total: 0, items: [] });
    }
    if (pathname === "/api/profiles/p1/experience-guard" && method === "GET") {
      const controls = options.guardControls || [
        options.guardControl || refreshRaceExperienceGuard(),
      ];
      const control = controls[Math.min(guardGetCalls, controls.length - 1)];
      guardGetCalls += 1;
      return refreshRaceJsonResponse(control);
    }
    if (pathname === "/api/profiles/p1/experience-guard" && method === "POST") {
      return refreshRaceJsonResponse({
        profileId: "p1",
        rearmState: "pending-authoritative-confirmation",
        request: { requestId: "rearm-p1" },
      }, options.guardPostStatus || 202);
    }
    if (pathname === "/api/profiles/p1/experience-guard/recover-settlement" && method === "POST") {
      return refreshRaceJsonResponse({
        profileId: "p1",
        recoveryState: "pending-authoritative-settlement-confirmation",
        request: {
          requestId: "recovery-p1",
          pendingRequestId: "pending-harvest",
        },
      }, options.guardPostStatus || 202);
    }
    if (pathname === "/api/profiles/p1/experience-guard/resolve-legacy-settlement" && method === "POST") {
      return refreshRaceJsonResponse({
        profileId: "p1",
        resolutionState: "resolved-operator-confirmed-legacy-recovery",
        request: {
          requestId: "legacy-recovery-p1",
          pendingRequestId: "pending-harvest",
          recoveryMode: "legacy-unverified",
        },
        state: {
          stateRevision: 8,
          invalid: false,
          invalidReason: null,
          breached: false,
          settlementResolution: {
            recoveryMode: "legacy-unverified",
          },
        },
      }, options.guardPostStatus || 200);
    }
    if (pathname === "/api/profiles/p1/once" && method === "POST") {
      if (options.failOnceAction) throw new Error("once request failed");
      return refreshRaceJsonResponse({ exitCode: 0 });
    }
    if (pathname === "/api/profiles/p1/start" && method === "POST") {
      startRequested = true;
      return refreshRaceJsonResponse({
        startedAt: "2026-08-14T12:00:00.000Z",
        pid: 321,
      });
    }
    return refreshRaceJsonResponse({ message: `unexpected request ${method} ${pathname}` }, 404);
  };

  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.confirm = originalConfirm;
  });

  await import(`./system/public/app.js?refresh-race=${Date.now()}-${Math.random()}`);
  return {
    document,
    intervals,
    requests,
    confirmMessages,
    runtimeCallCount: () => runtimeCalls,
    guardGetCallCount: () => guardGetCalls,
    releaseHeldRuntime() {
      heldRuntime.resolve(refreshRaceJsonResponse(refreshRaceRuntime()));
    },
  };
}

class RefreshRaceDocument {
  constructor() {
    this.elements = new Map();
    this.activeElement = null;
    this.queueTabs = [];
  }

  createElement(tagName) {
    return new RefreshRaceElement("", this, tagName);
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      this.elements.set(id, new RefreshRaceElement(id, this));
    }
    return this.elements.get(id);
  }

  querySelectorAll(selector) {
    return selector === "[data-queue-tab]" ? this.queueTabs : [];
  }

  addEventListener() {}

  exposeQueueTabs() {
    this.queueTabs = ["common", "secondary", "activities", "cyclic-note", "team-orders"].map((key) => {
      const element = new RefreshRaceElement(`queue-tab-${key}`, this, "button");
      element.dataset.queueTab = key;
      return element;
    });
  }

  queueTab(key) {
    return this.queueTabs.find((element) => element.dataset.queueTab === key);
  }
}

class RefreshRaceElement {
  constructor(id = "", ownerDocument = null, tagName = "div") {
    this.id = id;
    this.ownerDocument = ownerDocument;
    this.tagName = String(tagName).toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this._textContent = "";
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, enabled) => {
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
      },
    };
  }

  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent;
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  set innerHTML(_value) {
    throw new Error("refresh race harness forbids innerHTML");
  }

  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  insertBefore(node, referenceNode) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const index = referenceNode == null ? this.children.length : this.children.indexOf(referenceNode);
    if (index < 0) throw new Error("reference node must be a child");
    this.children.splice(index, 0, node);
    node.parentNode = this;
    return node;
  }

  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index < 0) throw new Error("removed node must be a child");
    this.children.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === "id") {
      this.id = normalized;
      this.ownerDocument?.elements.set(normalized, this);
    }
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = normalized;
    }
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this });
  }

  showModal() {}
  close() {}
}

function refreshRaceProfile(id, settingOverrides = {}) {
  const settings = {
    autoReceiveWaterwheelBuckets: true,
    skipWaterwheelVideoBuckets: false,
    autoSubmitOrdinaryResidentOrdersForLevelUp: false,
    autoSubmitCyclicStoryOrders: false,
    autoHandleCyclicNote: false,
    autoCompleteCyclicNoteHighestRewardTask: false,
    customerOrderFlowerCurrencyRewardReleaseMask: 4,
    cyclicStoryOnlyHighestExperienceOrder: false,
    experienceGuardThresholdPercent: 0.5,
    flowerRackTargetArtId: null,
    materialShopMidnightRefreshEnabled: false,
    materialShopRefreshWindowStart: "23:50",
    materialShopRefreshMaxCostYuanbao: 4,
    pearlHireItemReserveCount: 100,
    teamOrderTriggerProtectionEnabled: false,
    teamOrderPaidRenewProtectionEnabled: false,
    teamOrderGuardMultiplier: 2,
  };
  Object.assign(settings, settingOverrides);
  return {
    id,
    label: `账号 ${id}`,
    hasCredentials: true,
    missingFields: [],
    settings,
    settingsEpoch: "00000000-0000-4000-8000-0000000000a1",
    settingsRevision: 0,
    settingsKeyRevisions: Object.fromEntries(Object.keys(settings).map((key) => [key, 0])),
    runtimeSyncStatus: "synced",
    serverIdx: 1,
  };
}

function refreshRaceRuntime(options = {}) {
  const run = options.startRequested
    ? {
        profileId: "p1",
        pid: 321,
        startedAt: "2026-08-14T12:00:00.000Z",
        artifactCompletion: {
          garden: { complete: Boolean(options.artifactComplete) },
        },
      }
    : null;
  return {
    activeTasks: [],
    activeByProfile: run ? { p1: run } : {},
    lastTaskExits: {},
    runningCount: 0,
    legacyProcesses: [],
    server: { port: 43722, pid: 100, lock: true },
  };
}

function refreshRaceExperienceGuard(stateRevision = 7, options = {}) {
  return {
    profileId: "p1",
    state: {
      stateRevision,
      armedLevel: 19,
      ceilingLevel: 19,
      lastAuthoritativeLevel: 20,
      breached: options.breached ?? true,
      invalid: options.invalid ?? false,
    ...(options.invalidReason ? { invalidReason: options.invalidReason } : {}),
    },
    pendingRearm: options.pending ? { requestId: "rearm-p1" } : null,
    pendingSettlement: options.pendingSettlement || null,
    pendingSettlementRecovery: options.pendingSettlementRecovery || null,
  };
}

function findRefreshRaceById(root, id) {
  if (root?.id === id) return root;
  for (const child of root?.children || []) {
    const match = findRefreshRaceById(child, id);
    if (match) return match;
  }
  return null;
}

function findRefreshRaceByProfileId(root, profileId) {
  if (root?.getAttribute?.("data-profile-id") === profileId) return root;
  for (const child of root?.children || []) {
    const match = findRefreshRaceByProfileId(child, profileId);
    if (match) return match;
  }
  return null;
}

function refreshRaceJsonResponse(data, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

function refreshRaceDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function flushRefreshRaceTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
