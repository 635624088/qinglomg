import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const queueModule = await import("./system/public/queue-dashboard-view.js").catch(() => ({}));
const cyclicModule = await import("./system/public/cyclic-story-view.js").catch(() => ({}));
const { createQueueDashboardRenderer } = queueModule;
const { buildCyclicStoryView } = cyclicModule;

test("T4 exposes fixed queue cards, controls, and activity slots without queue rebuilds", async () => {
  assert.equal(typeof createQueueDashboardRenderer, "function");
  assert.equal(typeof buildCyclicStoryView, "function");
  const [app, view] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-dashboard-view.js", "utf8"),
  ]);
  const renderQueueSource = functionSlice(app, "renderQueue", "buildQueueDashboardView");
  const stopBannerSource = functionSlice(app, "renderAutomationStopBanner", "getExperienceGuardStopInfo", false);
  assert.doesNotMatch(renderQueueSource, /queueMatrix"\)\.innerHTML|activeElement[\s\S]*return;/);
  assert.doesNotMatch(stopBannerSource, /innerHTML/);
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);

  const fixture = createFixture();
  createRenderer(fixture);
  assert.equal(findAllByAttribute(fixture.nodes.queueMatrix, "data-queue-card").length, 14);
  assert.equal(findAllByAttribute(fixture.nodes.queueMatrix, "data-cyclic-story-slot").length, 3);
  for (const id of CONTROL_IDS) assert.ok(findById(fixture.document.body, id), id);
});

test("flower rack is the first secondary card and occupies half of the desktop row", async () => {
  const fixture = createFixture();
  createRenderer(fixture);
  const cards = findAllByAttribute(fixture.nodes.queueMatrix, "data-queue-card");
  assert.deepEqual(cards.slice(0, 8).map((card) => card.getAttribute("data-queue-card")), [
    "waterwheel",
    "free-water",
    "ordinary-resident",
    "satin-material",
    "experience-guard",
    "land-replant",
    "main-task",
    "customer-order",
  ]);
  assert.deepEqual(cards.slice(8, 13).map((card) => card.getAttribute("data-queue-card")), [
    "flower-rack",
    "palace-order",
    "guild-land",
    "pearl",
    "material-shop",
  ]);
  assert.equal(cards[7].classList.contains("queue-layout-common-8"), true);
  assert.equal(cards[8].classList.contains("queue-layout-secondary-1"), true);

  const styles = await readFile("work/system/public/styles.css", "utf8");
  assert.match(
    styles,
    /\.queue-matrix-secondary \.queue-layout-secondary-1\s*\{\s*grid-column:\s*span 6;/,
  );
});

test("cyclic-note uses its dedicated tab, selected state, and collection host", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  view.activeTab = "cyclic-note";
  view.secondary.cyclicNoteVisible = true;

  renderer.render(view);

  assert.equal(fixture.nodes.queueTabCyclicNote.classList.contains("active"), true);
  assert.equal(fixture.nodes.queueTabCyclicNote.getAttribute("aria-selected"), "true");
  assert.equal(fixture.nodes.queueTabCommon.classList.contains("active"), false);
  assert.equal(fixture.nodes.queueTabCommon.getAttribute("aria-selected"), "false");
  assert.equal(fixture.nodes.queueMatrix.getAttribute("class"), "queue-matrix queue-matrix-cyclic-note");
  assert.equal(findById(fixture.nodes.queueMatrix, "cyclicNoteHost").hidden, false);

  renderer.render({ ...view, activeTab: "secondary" });

  assert.equal(fixture.nodes.queueTabCyclicNote.getAttribute("aria-selected"), "false");
  assert.equal(findById(fixture.nodes.queueMatrix, "cyclicNoteHost").hidden, true);
});

test("customer order card renders daily count and exact reward release controls", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  view.common.customer = {
    state: "pending",
    hasData: true,
    pending: "2",
    dailyCompleted: "61",
    dailyLimit: "350",
    reward1Enabled: true,
    reward2Enabled: false,
    reward3Enabled: true,
    rewardControlsDisabled: false,
    rewardReleaseSummary: "放行收益 1、3；未选收益保持待处理或按官方按钮拒绝",
    settingsStatus: "设置已同步",
    status: "有 2 项待处理",
    rule: "按收益精确放行；库存/花艺保护继续生效",
  };

  renderer.render(view);

  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "customer-order-daily-completed").textContent,
    "61",
  );
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "customer-order-daily-limit").textContent,
    "350",
  );
  assert.equal(findById(fixture.document.body, "customerOrderReward1Toggle").checked, true);
  assert.equal(findById(fixture.document.body, "customerOrderReward2Toggle").checked, false);
  assert.equal(findById(fixture.document.body, "customerOrderReward3Toggle").checked, true);
  const customerCard = findByAttribute(fixture.document.body, "data-queue-card", "customer-order");
  const dailyMetrics = customerCard.children.find((child) => child.classList.contains("customer-order-daily-metrics"));
  assert.ok(dailyMetrics);
  assert.equal(dailyMetrics.children.length, 1);
  assert.equal(dailyMetrics.children[0].children[0].textContent, "今日完成");
  assert.deepEqual(
    Array.from(dailyMetrics.children[0].children[1].children).map((child) => child.textContent),
    ["61", "/", "350"],
  );
  const releasePanel = customerCard.children.find((child) => child.classList.contains("customer-order-reward-switches"));
  assert.ok(releasePanel);
  assert.equal(releasePanel.children[0].textContent, "花坊币收益放行");
  for (const reward of [1, 2, 3]) {
    const id = `customerOrderReward${reward}Toggle`;
    const label = findByAttribute(customerCard, "for", id);
    assert.equal(label.parentNode, releasePanel);
    assert.equal(label.classList.contains("queue-switch"), true);
    assert.equal(label.children[0].id, id);
    assert.equal(label.children[1].textContent, `收益 ${reward}`);
  }
  assert.equal(findById(fixture.document.body, "customerOrderReward1Toggle").disabled, false);
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "customer-order-settings-status").textContent,
    "设置已同步",
  );

  const unknown = structuredClone(view);
  unknown.common.customer.dailyCompleted = "-";
  unknown.common.customer.dailyLimit = "-";
  unknown.common.customer.rewardControlsDisabled = true;
  unknown.common.customer.settingsStatus = "设置冲突，已暂停修改";
  renderer.render(unknown);
  assert.equal(findById(fixture.document.body, "customerOrderReward1Toggle").disabled, true);
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "customer-order-daily-completed").textContent,
    "-",
  );
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "customer-order-daily-limit").textContent,
    "-",
  );
});

test("satin and material render independent status and missing detail leaves", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  view.common.satin.satinCooldown = "缺少材料";
  view.common.satin.satinMissing = "黄玫瑰(1/0)";
  view.common.satin.materialCooldown = "冷却中（3分20秒）";
  view.common.satin.materialMissing = "无";

  renderer.render(view);

  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "satin-cooldown")?.textContent,
    "缺少材料",
  );
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "satin-missing")?.textContent,
    "黄玫瑰(1/0)",
  );
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "material-cooldown")?.textContent,
    "冷却中（3分20秒）",
  );
  assert.equal(
    findByAttribute(fixture.document.body, "data-queue-field", "material-missing")?.textContent,
    "无",
  );
});

test("satin material metrics use the stock row followed by silk and material rows", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  renderer.render(queueView());

  const card = findByAttribute(fixture.nodes.queueMatrix, "data-queue-card", "satin-material");
  const metrics = card.children.find((child) => child.classList.contains("satin-material-metrics"));
  assert.ok(metrics);
  assert.deepEqual(
    Array.from(metrics.children).map((metricRoot) => metricRoot.children[0].textContent),
    ["丝绸", "建材", "丝绸完成", "丝绸状态", "丝绸缺货", "建材完成", "建材状态", "建材缺货"],
  );
  assert.deepEqual(
    Array.from(metrics.children).map((metricRoot) => findAllByAttribute(metricRoot, "data-queue-field")[0]?.getAttribute("data-queue-field")),
    [
      "satin-value",
      "material-value",
      "satin-completed",
      "satin-cooldown",
      "satin-missing",
      "material-completed",
      "material-cooldown",
      "material-missing",
    ],
  );
});

test("same new-object queue snapshot keeps identity and performs zero writes", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  renderer.render(view);
  const cards = findAllByAttribute(fixture.nodes.queueMatrix, "data-queue-card");
  const controls = CONTROL_IDS.map((id) => findById(fixture.document.body, id));
  fixture.clearWrites();

  renderer.render(structuredClone(view));

  assertDomRecords(fixture.writes, []);
  assertDomRecords(fixture.structuralWrites, []);
  assert.deepEqual(findAllByAttribute(fixture.nodes.queueMatrix, "data-queue-card"), cards);
  assert.deepEqual(CONTROL_IDS.map((id) => findById(fixture.document.body, id)), controls);
});

test("waterwheel card renders account bucket receive and indented video bucket controls", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);

  renderer.render(queueView());

  const receiveToggle = findById(fixture.document.body, "waterwheelBucketReceiveToggle");
  const skipToggle = findById(fixture.document.body, "waterwheelVideoBucketSkipToggle");
  const receiveLabel = findByAttribute(
    fixture.document.body,
    "for",
    "waterwheelBucketReceiveToggle",
  );
  const skipLabel = findByAttribute(
    fixture.document.body,
    "for",
    "waterwheelVideoBucketSkipToggle",
  );
  const receiveState = findByAttribute(
    fixture.document.body,
    "data-queue-field",
    "waterwheel-bucket-receive-enabled",
  );
  const explanation = findByAttribute(
    fixture.document.body,
    "data-queue-field",
    "waterwheel-video-bucket-skip-description",
  );

  assert.ok(receiveToggle);
  assert.ok(skipToggle);
  assert.equal(receiveToggle.checked, true);
  assert.equal(receiveToggle.disabled, false);
  assert.equal(skipToggle.checked, false);
  assert.equal(skipToggle.disabled, false);
  assert.equal(receiveLabel.classList.contains("queue-switch"), true);
  assert.equal(skipLabel.classList.contains("queue-switch"), true);
  assert.equal(skipLabel.classList.contains("waterwheel-video-bucket-skip-switch"), true);
  assert.equal(receiveState.textContent, "开启");
  assert.equal(explanation.textContent, "跳过视频观看，领取当前桶基础 3–7 水滴；不是丢弃该桶");
});

test("waterwheel video bucket child control has real indentation and narrow-screen wrapping styles", async () => {
  const styles = await readFile("work/system/public/styles.css", "utf8");

  assert.match(
    styles,
    /\.waterwheel-video-bucket-skip-switch\s*\{(?=[^}]*margin-left:\s*16px)(?=[^}]*min-width:\s*0)[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.waterwheel-video-bucket-skip-switch\s*>\s*span\s*\{(?=[^}]*display:\s*grid)(?=[^}]*min-width:\s*0)[^}]*\}/s,
  );
  assert.match(
    styles,
    /\.waterwheel-video-bucket-skip-switch\s+small\s*\{(?=[^}]*display:\s*block)(?=[^}]*overflow-wrap:\s*anywhere)(?=[^}]*white-space:\s*normal)[^}]*\}/s,
  );
});

test("waterwheel parent off or no account disables the child without losing its saved checked value", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  view.common.waterwheel.videoBucketSkipEnabled = true;
  renderer.render(view);
  const receiveToggle = findById(fixture.document.body, "waterwheelBucketReceiveToggle");
  const skipToggle = findById(fixture.document.body, "waterwheelVideoBucketSkipToggle");
  const receiveState = findByAttribute(
    fixture.document.body,
    "data-queue-field",
    "waterwheel-bucket-receive-enabled",
  );
  fixture.clearWrites();

  const parentOff = structuredClone(view);
  parentOff.common.waterwheel.bucketReceiveEnabled = false;
  parentOff.common.waterwheel.bucketReceiveEnabledText = "关闭";
  parentOff.common.waterwheel.videoBucketSkipDisabled = true;
  renderer.render(parentOff);

  assert.equal(receiveToggle.checked, false);
  assert.equal(receiveState.textContent, "关闭");
  assert.equal(skipToggle.checked, true);
  assert.equal(skipToggle.disabled, true);
  assertDomRecords(fixture.writes, [
    { node: receiveToggle, kind: "property", name: "checked", value: false },
    { node: receiveState, kind: "property", name: "textContent", value: "关闭" },
    { node: skipToggle, kind: "property", name: "disabled", value: true },
  ]);
  assertDomRecords(fixture.structuralWrites, []);
  fixture.clearWrites();

  const parentOn = structuredClone(parentOff);
  parentOn.common.waterwheel.bucketReceiveEnabled = true;
  parentOn.common.waterwheel.bucketReceiveEnabledText = "开启";
  parentOn.common.waterwheel.videoBucketSkipDisabled = false;
  renderer.render(parentOn);

  assert.equal(receiveToggle.checked, true);
  assert.equal(receiveState.textContent, "开启");
  assert.equal(skipToggle.checked, true);
  assert.equal(skipToggle.disabled, false);
  assertDomRecords(fixture.writes, [
    { node: receiveToggle, kind: "property", name: "checked", value: true },
    { node: receiveState, kind: "property", name: "textContent", value: "开启" },
    { node: skipToggle, kind: "property", name: "disabled", value: false },
  ]);
  assertDomRecords(fixture.structuralWrites, []);
  fixture.clearWrites();

  const noAccount = structuredClone(parentOn);
  noAccount.common.waterwheel.bucketReceiveDisabled = true;
  noAccount.common.waterwheel.videoBucketSkipDisabled = true;
  renderer.render(noAccount);

  assert.equal(receiveToggle.disabled, true);
  assert.equal(skipToggle.checked, true);
  assert.equal(skipToggle.disabled, true);
  assertDomRecords(fixture.writes, [
    { node: receiveToggle, kind: "property", name: "disabled", value: true },
    { node: skipToggle, kind: "property", name: "disabled", value: true },
  ]);
  assertDomRecords(fixture.structuralWrites, []);
});

test("waterwheel runtime effective state updates status without overriding profile checked values", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  view.common.waterwheel.videoBucketSkipEnabled = true;
  renderer.render(view);
  const receiveToggle = findById(fixture.document.body, "waterwheelBucketReceiveToggle");
  const skipToggle = findById(fixture.document.body, "waterwheelVideoBucketSkipToggle");
  const status = findByAttribute(fixture.document.body, "data-queue-field", "waterwheel-status");
  fixture.clearWrites();

  const runtimeDisabled = structuredClone(view);
  runtimeDisabled.common.waterwheel.effectiveAutoReceiveEnabled = false;
  runtimeDisabled.common.waterwheel.effectiveSkipVideoBucketsEnabled = false;
  runtimeDisabled.common.waterwheel.status = "AUTO_HANDLE_WATERWHEEL 已关闭；仅同步状态";
  renderer.render(runtimeDisabled);

  assert.equal(receiveToggle.checked, true);
  assert.equal(skipToggle.checked, true);
  assertDomRecords(fixture.writes, [
    {
      node: status,
      kind: "property",
      name: "textContent",
      value: "AUTO_HANDLE_WATERWHEEL 已关闭；仅同步状态",
    },
  ]);
  assertDomRecords(fixture.structuralWrites, []);
});

test("each waterwheel switch field patches only its matching dynamic node or property", () => {
  const cases = [
    {
      path: ["common", "waterwheel", "bucketReceiveEnabled"],
      value: false,
      id: "waterwheelBucketReceiveToggle",
      name: "checked",
    },
    {
      path: ["common", "waterwheel", "bucketReceiveDisabled"],
      value: true,
      id: "waterwheelBucketReceiveToggle",
      name: "disabled",
    },
    {
      path: ["common", "waterwheel", "bucketReceiveEnabledText"],
      value: "关闭",
      field: "waterwheel-bucket-receive-enabled",
      name: "textContent",
    },
    {
      path: ["common", "waterwheel", "videoBucketSkipEnabled"],
      value: true,
      id: "waterwheelVideoBucketSkipToggle",
      name: "checked",
    },
    {
      path: ["common", "waterwheel", "videoBucketSkipDisabled"],
      value: true,
      id: "waterwheelVideoBucketSkipToggle",
      name: "disabled",
    },
  ];

  for (const item of cases) {
    const fixture = createFixture();
    const renderer = createRenderer(fixture);
    const view = queueView();
    renderer.render(view);
    const node = item.id
      ? findById(fixture.document.body, item.id)
      : findByAttribute(fixture.document.body, "data-queue-field", item.field);
    fixture.clearWrites();

    renderer.render(withValue(view, item.path, item.value));

    assertDomRecords(fixture.writes, [
      { node, kind: "property", name: item.name, value: item.value },
    ], item.path.join("."));
    assertDomRecords(fixture.structuralWrites, [], item.path.join("."));
  }
});

test("cyclic story auto submit toggle patches checked, disabled, and copy without rebuilds", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  renderer.render(view);
  const toggle = findById(fixture.document.body, "cyclicStoryAutoSubmitToggle");
  const onlyHighestToggle = findById(
    fixture.document.body,
    "cyclicStoryOnlyHighestExperienceToggle",
  );
  const enabledText = findByAttribute(
    fixture.document.body,
    "data-cyclic-story-field",
    "auto-submit-enabled",
  );
  assert.ok(toggle);
  assert.ok(onlyHighestToggle);
  assert.equal(toggle.checked, false);
  assert.equal(toggle.disabled, false);
  assert.equal(onlyHighestToggle.checked, false);
  assert.equal(onlyHighestToggle.disabled, true);
  assert.equal(enabledText.textContent, "关闭");
  fixture.clearWrites();

  const enabledView = withValue(view, ["cyclicStory", "autoSubmitEnabled"], true);
  // app.js 每次重建 view 时 buildCyclicStoryView 会同步计算 enabledText
  enabledView.cyclicStory.enabledText = "开启";
  enabledView.cyclicStory.onlyHighestExperienceDisabled = false;
  renderer.render(enabledView);
  assertDomRecords(fixture.writes, [
    { node: toggle, kind: "property", name: "checked", value: true },
    { node: enabledText, kind: "property", name: "textContent", value: "开启" },
    { node: onlyHighestToggle, kind: "property", name: "disabled", value: false },
  ]);
  assertDomRecords(fixture.structuralWrites, []);

  fixture.clearWrites();
  const disabledView = withValue(enabledView, ["cyclicStory", "disabled"], true);
  renderer.render(disabledView);
  assertDomRecords(fixture.writes, [
    { node: toggle, kind: "property", name: "disabled", value: true },
  ]);
  assertDomRecords(fixture.structuralWrites, []);

  fixture.clearWrites();
  renderer.render(structuredClone(disabledView));
  assertDomRecords(fixture.writes, []);
  assertDomRecords(fixture.structuralWrites, []);
});

test("changing cycle or a generic pending value only writes its own leaf and necessary state class", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  renderer.render(view);
  const cycle = findByAttribute(fixture.document.body, "data-queue-field", "cycle");
  const pending = findByAttribute(fixture.document.body, "data-queue-field", "free-water-pending");
  const freeWater = findByAttribute(fixture.document.body, "data-queue-card", "free-water");
  fixture.clearWrites();

  renderer.render({
    ...view,
    cycle: "11",
    common: {
      ...view.common,
      freeWater: { ...view.common.freeWater, state: "pending", pending: "1" },
    },
  });

  assertDomRecords(fixture.writes, [
    { node: cycle, kind: "property", name: "textContent", value: "11" },
    { node: freeWater, kind: "class-toggle", name: "pending", value: true },
    { node: freeWater, kind: "class-toggle", name: "idle", value: false },
    { node: pending, kind: "property", name: "textContent", value: "1" },
  ]);
  assertDomRecords(fixture.structuralWrites, []);
});

test("independent queue values patch only their own dynamic leaf", () => {
  const cases = [
    [["cycle"], "cycle", "11"],
    [["step"], "step", "submitOrders"],
    [["common", "waterwheel", "waterDrop"], "waterwheel-water-drop", "33/65"],
    [["common", "waterwheel", "nextDrop"], "waterwheel-next-drop", "1分08秒"],
    [["common", "waterwheel", "bucketCurrent"], "waterwheel-bucket-current", "31"],
    [["common", "waterwheel", "bucketMax"], "waterwheel-bucket-max", "61"],
    [["common", "waterwheel", "claimedToday"], "waterwheel-claimed-today", "11"],
    [["common", "waterwheel", "dailyMax"], "waterwheel-daily-max", "61"],
    [["common", "waterwheel", "dailyRemaining"], "waterwheel-daily-remaining", "50"],
    [["common", "waterwheel", "nextGeneration"], "waterwheel-next-generation", "29秒"],
    [["common", "waterwheel", "nextBucket"], "waterwheel-next-bucket", "32"],
    [["common", "freeWater", "status"], "free-water-status", "等待同步"],
    [["common", "freeWater", "rule"], "free-water-rule", "新的服务端规则"],
    [["common", "ordinary", "enabledText"], "ordinary-enabled", "开启"],
    [["common", "ordinary", "completed"], "ordinary-completed", "1"],
    [["common", "ordinary", "ready"], "ordinary-ready", "5"],
    [["common", "ordinary", "total"], "ordinary-total", "7"],
    [["common", "ordinary", "gateReason"], "ordinary-gate", "主线已放行"],
    [["common", "satin", "satin"], "satin-value", "338"],
    [["common", "satin", "material"], "material-value", "769"],
    [["common", "satin", "satinCompleted"], "satin-completed", "67"],
    [["common", "satin", "satinLimit"], "satin-limit", "121"],
    [["common", "satin", "materialCompleted"], "material-completed", "67"],
    [["common", "satin", "materialLimit"], "material-limit", "121"],
    [["common", "satin", "satinCooldown"], "satin-cooldown", "0分03秒"],
    [["common", "satin", "materialCooldown"], "material-cooldown", "0分03秒"],
    [["common", "experienceGuard", "status"], "experience-status", "即将触发"],
    [["common", "experienceGuard", "threshold"], "experience-threshold", "9180"],
    [["common", "experienceGuard", "remaining"], "experience-remaining", "577,3654"],
    [["common", "land", "status"], "land-replant-status", "存在空地 1 块"],
    [["common", "mainTask", "taskId"], "main-task-id", "5110002"],
    [["common", "mainTask", "taskType"], "main-task-type", "3"],
    [["common", "mainTask", "progress"], "main-task-progress", "46/47"],
    [["common", "mainTask", "remaining"], "main-task-remaining", "2"],
    [["common", "mainTask", "status"], "main-task-status", "可领取"],
    [["common", "mainTask", "detailTaskId"], "main-task-detail-id", "5110002"],
    [["common", "mainTask", "description"], "main-task-description", "等级提升至47级"],
    [["common", "mainTask", "receiveState"], "main-task-receive-state", "可领取"],
    [["common", "mainTask", "rule"], "main-task-rule", "新的主线规则"],
    [["secondary", "palace", "status"], "palace-order-status", "等待订单"],
    [["common", "customer", "status"], "customer-order-status", "等待顾客"],
    [["secondary", "guild", "status"], "guild-land-status", "等待土地"],
    [["secondary", "flowerRack", "description"], "flower-rack-description", "新配方说明"],
    [["secondary", "flowerRack", "selectedLabel"], "flower-rack-selected-label", "藤韵花篮"],
    [["secondary", "flowerRack", "status"], "flower-rack-status", "等待上架"],
    [["secondary", "flowerRack", "rule"], "flower-rack-rule", "新的花架规则"],
    [["secondary", "pearl", "status"], "pearl-status", "等待采集"],
    [["secondary", "materialShop", "enabledText"], "material-enabled-text", "已开启"],
    [["secondary", "materialShop", "maxSpend"], "material-rule-max-spend", "20"],
    [["secondary", "materialShop", "status"], "material-shop-status", "等待刷新"],
  ];

  for (const [path, field, value] of cases) {
    const fixture = createFixture();
    const renderer = createRenderer(fixture);
    const view = queueView();
    renderer.render(view);
    const node = findByAttribute(fixture.document.body, "data-queue-field", field);
    assert.ok(node, field);
    fixture.clearWrites();

    renderer.render(withValue(view, path, value));

    assertDomRecords(fixture.writes, [
      { node, kind: "property", name: "textContent", value },
    ], path.join("."));
    assertDomRecords(fixture.structuralWrites, [], path.join("."));
  }
});

test("mixed configuration descriptions update only their controls and value fragments", () => {
  const cases = [
    {
      path: ["secondary", "pearl", "reserve"],
      value: "101",
      expected: [
        ["id", "pearlHireItemReserveInput", "value", "101"],
        ["field", "pearl-rule-reserve", "textContent", "101"],
      ],
    },
    {
      path: ["secondary", "materialShop", "maxCost"],
      value: "8",
      expected: [
        ["id", "materialShopRefreshMaxCostSelect", "value", "8"],
        ["field", "material-rule-max-cost", "textContent", "8"],
      ],
    },
  ];

  for (const { path, value, expected } of cases) {
    const fixture = createFixture();
    const renderer = createRenderer(fixture);
    const view = queueView();
    renderer.render(view);
    const expectedWrites = expected.map(([kind, key, name, nextValue]) => ({
      node: kind === "id"
        ? findById(fixture.document.body, key)
        : findByAttribute(fixture.document.body, "data-queue-field", key),
      kind: "property",
      name,
      value: nextValue,
    }));
    fixture.clearWrites();

    renderer.render(withValue(view, path, value));

    assertDomRecords(fixture.writes, expectedWrites, path.join("."));
    assertDomRecords(fixture.structuralWrites, [], path.join("."));
  }
});

test("automation stop banner keeps its shell and patches a changed title only", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = { ...queueView(), stopInfo: { kind: "experience-guard", title: "经验保护停止", message: "请检查配置" } };
  renderer.render(view);
  assert.equal(fixture.nodes.automationStopBanner.hidden, false);
  assert.equal(fixture.nodes.automationStopBanner.classList.contains("visible"), true);
  assert.equal(fixture.nodes.automationStopBanner.getAttribute("data-stop-kind"), "experience-guard");
  fixture.clearWrites();

  renderer.render({ ...view, stopInfo: { ...view.stopInfo, title: "登录状态停止" } });

  assertDomRecords(fixture.writes, [{ node: fixture.nodes.automationStopTitle, kind: "property", name: "textContent", value: "登录状态停止" }]);
  assertDomRecords(fixture.structuralWrites, []);
});

test("focused dirty config value survives polling while adjacent live fields update", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  renderer.render(view);
  const input = findById(fixture.document.body, "experienceGuardThresholdInput");
  const threshold = findByAttribute(fixture.document.body, "data-queue-field", "experience-threshold");
  fixture.document.activeElement = input;
  input.value = "0.07";
  fixture.clearWrites();

  renderer.render({
    ...view,
    common: {
      ...view.common,
      experienceGuard: {
        ...view.common.experienceGuard,
        inputValue: "0.05",
        threshold: "9180",
      },
    },
  }, { dirtyControlIds: new Set([input.id]) });

  assert.strictEqual(fixture.document.activeElement, input);
  assert.equal(input.value, "0.07");
  assertDomRecords(fixture.writes, [
    { node: threshold, kind: "property", name: "textContent", value: "9180" },
  ]);

  fixture.clearWrites();
  renderer.render(view, {
    dirtyControlIds: new Set([input.id]),
    forceControlIds: new Set([input.id]),
  });
  assert.equal(input.value, "0.05");
  assertDomRecords(fixture.writes, [
    { node: input, kind: "property", name: "value", value: "0.05" },
    { node: threshold, kind: "property", name: "textContent", value: "9179" },
  ]);
});

test("experience guard card exposes explicit rearm only for a recoverable persistent lock", () => {
  const fixture = createFixture();
  const rearmCalls = [];
  const renderer = createRenderer(fixture, {
    onExperienceGuardRearm: () => rearmCalls.push("rearm"),
  });
  const view = queueView();
  renderer.render(view);
  const button = findById(fixture.document.body, "experienceGuardRearmButton");
  const note = findByAttribute(
    fixture.document.body,
    "data-queue-field",
    "experience-rearm-status",
  );

  assert.ok(button);
  assert.equal(button.hidden, true);

  const blocked = structuredClone(view);
  blocked.common.experienceGuard = {
    ...blocked.common.experienceGuard,
    state: "blocked",
    panelBlocked: true,
    rearmVisible: true,
    rearmDisabled: false,
    rearmPending: false,
    rearmStatus: "停止或重启不会解除；请确认当前等级后重新布防。",
  };
  renderer.render(blocked);

  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "重新布防当前等级");
  assert.equal(note.textContent, "停止或重启不会解除；请确认当前等级后重新布防。");
  button.click();
  assert.deepEqual(rearmCalls, ["rearm"]);

  const pending = structuredClone(blocked);
  pending.common.experienceGuard.rearmDisabled = true;
  pending.common.experienceGuard.rearmPending = true;
  pending.common.experienceGuard.rearmStatus = "重新布防已提交，等待实时等级确认。";
  renderer.render(pending);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "等待权威确认");
  assert.equal(note.textContent, "重新布防已提交，等待实时等级确认。");
});

test("all editable value controls protect only their focused draft during polling", () => {
  const cases = [
    {
      id: "flowerRackTargetSelect",
      draft: "305101",
      serverValue: "",
      update(view) {
        view.secondary.flowerRack.selectedArtId = "";
        view.secondary.flowerRack.description = "轮询后的配方说明";
      },
      adjacentField: "flower-rack-description",
      adjacentValue: "轮询后的配方说明",
    },
    {
      id: "pearlHireItemReserveInput",
      draft: "123",
      serverValue: "101",
      update(view) {
        view.secondary.pearl.reserve = "101";
        view.secondary.pearl.status = "轮询后的珍珠状态";
      },
      adjacentField: "pearl-status",
      adjacentValue: "轮询后的珍珠状态",
    },
    {
      id: "materialShopRefreshWindowStartInput",
      draft: "23:55",
      serverValue: "23:45",
      update(view) {
        view.secondary.materialShop.windowStart = "23:45";
        view.secondary.materialShop.status = "轮询后的商城状态";
      },
      adjacentField: "material-shop-status",
      adjacentValue: "轮询后的商城状态",
    },
    {
      id: "materialShopRefreshMaxCostSelect",
      draft: "12",
      serverValue: "8",
      update(view) {
        view.secondary.materialShop.maxCost = "8";
        view.secondary.materialShop.maxSpend = "20";
      },
      adjacentField: "material-rule-max-spend",
      adjacentValue: "20",
    },
    {
      id: "teamOrderGuardMultiplierInput",
      draft: "3",
      serverValue: "2",
      update(view) {
        view.teamOrderSettings.guardMultiplier = "2";
        view.teamOrderSettings.guardFormulaText = "历史最高 5000 × 2 = 10000";
      },
      adjacentField: "team-order-guard-formula",
      adjacentValue: "历史最高 5000 × 2 = 10000",
    },
  ];

  for (const item of cases) {
    const fixture = createFixture();
    const renderer = createRenderer(fixture);
    const view = queueView();
    renderer.render(view);
    const control = findById(fixture.document.body, item.id);
    const next = structuredClone(view);
    item.update(next);
    fixture.document.activeElement = control;
    control.value = item.draft;
    fixture.clearWrites();

    renderer.render(next, { dirtyControlIds: new Set([item.id]) });

    assert.equal(control.value, item.draft, item.id);
    assert.equal(fixture.writes.some((write) => write.node === control), false, item.id);
    assert.equal(
      findByAttribute(fixture.document.body, "data-queue-field", item.adjacentField).textContent,
      item.adjacentValue,
      item.id,
    );
    assertDomRecords(fixture.structuralWrites, [], item.id);

    fixture.clearWrites();
    renderer.render(next, {
      dirtyControlIds: new Set([item.id]),
      forceControlIds: new Set([item.id]),
    });
    assert.equal(control.value, item.serverValue, item.id);
    assertDomRecords(fixture.writes, [
      { node: control, kind: "property", name: "value", value: item.serverValue },
    ], item.id);
  }
});

test("flower rack options follow the current account and retain an outside Top 5 selection", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const accountA = queueView();
  accountA.secondary.flowerRack = {
    ...accountA.secondary.flowerRack,
    selectedArtId: "302009",
    options: [
      { artId: null, label: "不自动上架", description: "只收取到期金币" },
      { artId: 302009, label: "302009(幽木流芳+星河映蕊+蜜合月见草+金白德鸢)", description: "金币单价 1200" },
      { artId: 301722, label: "301722(丹青瓷瓶+轻紫大花葱+蓝叶苏铁+粉鹤芋)", description: "金币单价 1100" },
    ],
  };

  renderer.render(accountA);
  const select = findById(fixture.document.body, "flowerRackTargetSelect");
  assert.equal(select.value, "302009");
  assert.deepEqual(
    select.children.map((option) => [option.getAttribute("value"), option.textContent]),
    [
      ["", "不自动上架"],
      ["302009", "302009(幽木流芳+星河映蕊+蜜合月见草+金白德鸢)"],
      ["301722", "301722(丹青瓷瓶+轻紫大花葱+蓝叶苏铁+粉鹤芋)"],
    ],
  );

  const accountB = structuredClone(accountA);
  accountB.secondary.flowerRack.selectedArtId = "305101";
  accountB.secondary.flowerRack.options = [
    { artId: null, label: "不自动上架", description: "只收取到期金币" },
    { artId: 300307, label: "300307(云纹瓶+红玫瑰)", description: "金币单价 900" },
    { artId: 305101, label: "305101(藤韵花篮+棉花小熊+轮生冬青+粉红木槿花)", description: "上次选择，不在当前金币 Top 5 中" },
  ];

  fixture.document.activeElement = select;
  select.value = "301722";
  fixture.clearWrites();
  renderer.render(accountB, { dirtyControlIds: new Set(["flowerRackTargetSelect"]) });
  assert.equal(select.value, "301722");
  assert.deepEqual(
    select.children.map((option) => option.getAttribute("value")),
    ["", "302009", "301722"],
  );
  assertDomRecords(fixture.structuralWrites, []);

  renderer.render(accountB, { forceControlIds: new Set(["flowerRackTargetSelect"]) });

  assert.equal(select.value, "305101");
  assert.deepEqual(
    select.children.map((option) => [option.getAttribute("value"), option.textContent]),
    [
      ["", "不自动上架"],
      ["300307", "300307(云纹瓶+红玫瑰)"],
      ["305101", "305101(藤韵花篮+棉花小熊+轮生冬青+粉红木槿花)"],
    ],
  );
});

test("tab changes and team protection updates preserve fixed nodes", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = queueView();
  renderer.render(view);
  const cards = findAllByAttribute(fixture.nodes.queueMatrix, "data-queue-card");
  const trigger = findById(fixture.document.body, "teamOrderProtectionToggle");
  const remaining = findByAttribute(fixture.document.body, "data-queue-field", "team-trigger-double-gold");
  fixture.clearWrites();

  renderer.render({
    ...view,
    activeTab: "team-orders",
    teamOrderSettings: {
      ...view.teamOrderSettings,
      triggerReleaseEnabled: true,
      triggerMode: "forced",
      doubleGoldRemaining: "2分59秒",
    },
  });

  assert.deepEqual(findAllByAttribute(fixture.nodes.queueMatrix, "data-queue-card"), cards);
  assert.equal(trigger.checked, true);
  assert.equal(remaining.textContent, "2分59秒");
  assert.equal(fixture.nodes.queueMatrix.hidden, true);
  assert.equal(fixture.nodes.teamOrderPanel.hidden, false);
  assertDomRecords(fixture.structuralWrites, []);

  const guardFormula = findByAttribute(fixture.document.body, "data-queue-field", "team-order-guard-formula");
  assert.equal(guardFormula.textContent, "暂无组团经验历史");
  fixture.clearWrites();
  renderer.render({
    ...view,
    activeTab: "team-orders",
    teamOrderSettings: {
      ...view.teamOrderSettings,
      guardMultiplier: "2",
      guardFormulaText: "历史最高 5000 × 2 = 10000",
    },
  });
  assert.equal(guardFormula.textContent, "历史最高 5000 × 2 = 10000");
  assertDomRecords(fixture.structuralWrites, []);
});

test("T5 connects ordinary contents, cyclic note, and team archives to keyed renderers", async () => {
  const [app, queueCollections, archiveView, tasks] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/queue-collections-view.js", "utf8"),
    readFile("work/system/public/team-order-archive-view.js", "utf8"),
    readFile("docs/specs/2026-08-03-console-static-structure-incremental-updates/tasks.md", "utf8"),
  ]);
  assert.match(app, /queueCollections\.renderOrdinary\(/);
  assert.match(app, /queueCollections\.renderCyclicNote\(/);
  assert.match(app, /teamOrderArchive\.render\(/);
  assert.doesNotMatch(app, /ordinaryResidentSlotsHost"\)\.innerHTML|cyclicNoteHost"\)\.innerHTML|teamOrderArchiveList"\)\.innerHTML/);
  assert.doesNotMatch(queueCollections, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.doesNotMatch(archiveView, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.match(tasks, /T5[\s\S]*六个普通居民订单槽位固定/s);
  assert.match(tasks, /T5[\s\S]*花笺集芳卡按条件增删/s);
  assert.match(tasks, /T5[\s\S]*组团日期组/s);
});

const CONTROL_IDS = [
  "waterwheelBucketReceiveToggle",
  "waterwheelVideoBucketSkipToggle",
  "ordinaryAutoSubmitToggle",
  "experienceGuardThresholdInput",
  "experienceGuardRearmButton",
  "flowerRackTargetSelect",
  "pearlHireItemReserveInput",
  "materialShopMidnightRefreshToggle",
  "materialShopRefreshWindowStartInput",
  "materialShopRefreshMaxCostSelect",
  "teamOrderProtectionToggle",
  "teamOrderPaidRenewProtectionToggle",
  "teamOrderGuardMultiplierInput",
  "cyclicStoryAutoSubmitToggle",
  "cyclicStoryOnlyHighestExperienceToggle",
  "customerOrderReward1Toggle",
  "customerOrderReward2Toggle",
  "customerOrderReward3Toggle",
];

function createRenderer(fixture, options = {}) {
  return createQueueDashboardRenderer(fixture.getNode, {
    materialShopCostOptions: [0, 1, 2, 4, 8, 12, 16],
    ...options,
  });
}

function queueView() {
  const generic = (overrides = {}) => ({
    state: "idle",
    hasData: true,
    pending: "0",
    status: "正常",
    rule: "固定服务端规则",
    ...overrides,
  });
  return {
    activeTab: "common",
    cycle: "10",
    step: "loopStatusRefresh",
    stopInfo: null,
    statusOk: true,
    common: {
      waterwheel: generic({
        bucketReceiveEnabled: true,
        bucketReceiveDisabled: false,
        bucketReceiveEnabledText: "开启",
        videoBucketSkipEnabled: false,
        videoBucketSkipDisabled: false,
        waterDrop: "32/65",
        nextDrop: "1分09秒",
        bucketCurrent: "30",
        bucketMax: "8",
        claimedToday: "2",
        dailyMax: "60",
        dailyRemaining: "58",
        nextGeneration: "30秒",
        nextBucket: "31",
        nextBucketVideo: false,
      }),
      freeWater: generic(),
      ordinary: {
        state: "idle",
        enabled: false,
        disabled: false,
        enabledText: "关闭",
        completed: "0",
        ready: "6",
        total: "6",
        gateReason: "等级提升主线未完成",
      },
      satin: generic({
        satin: "337",
        material: "768",
        satinCompleted: "66",
        satinLimit: "120",
        materialCompleted: "66",
        materialLimit: "120",
        satinCooldown: "0分04秒",
        satinMissing: "无",
        materialCooldown: "0分04秒",
        materialMissing: "无",
      }),
      experienceGuard: {
        state: "idle",
        hasData: true,
        pending: "0",
        inputValue: "0.05",
        inputDisabled: false,
        inputBusy: false,
        panelBlocked: false,
        panelPending: false,
        status: "正常",
        threshold: "9179",
        remaining: "577,3655",
        rule: "经验保护服务端规则",
        rearmVisible: false,
        rearmDisabled: true,
        rearmPending: false,
        rearmStatus: "",
      },
      land: generic(),
      mainTask: {
        state: "idle",
        hasTask: true,
        taskId: "5110001",
        taskType: "2",
        progress: "45/46",
        remaining: "1",
        status: "进行中：还差 1 次",
        detailTaskId: "5110001",
        description: "等级提升至46级",
        receiveState: "进行中/未达标",
        rule: "主线服务端规则",
      },
      customer: {
        state: "idle",
        hasData: true,
        pending: "0",
        dailyCompleted: "-",
        dailyLimit: "-",
        reward1Enabled: false,
        reward2Enabled: false,
        reward3Enabled: true,
        rewardControlsDisabled: false,
        rewardReleaseSummary: "放行收益 3",
        settingsStatus: "设置已同步",
        status: "暂无可执行动作",
        rule: "按收益精确放行；库存/花艺保护继续生效",
      },
    },
    secondary: {
      palace: generic(),
      guild: generic(),
      flowerRack: {
        state: "idle",
        selectedArtId: "",
        options: [
          { artId: null, label: "不自动上架", description: "只收取到期金币" },
          { artId: 305101, label: "305101(藤韵花篮+棉花小熊)", description: "配方一" },
        ],
        disabled: false,
        description: "只收取到期金币",
        hasData: true,
        pending: "0",
        selectedLabel: "不自动上架",
        status: "正常",
        rule: "花架服务端规则",
      },
      pearl: {
        state: "idle",
        reserve: "100",
        disabled: false,
        hasData: true,
        pending: "0",
        status: "正常",
        rule: "",
      },
      materialShop: {
        state: "idle",
        enabled: false,
        disabled: false,
        enabledText: "默认关闭",
        windowStart: "23:50",
        maxCost: "4",
        maxSpend: "15",
        hasData: true,
        pending: "0",
        status: "正常",
        rule: "",
      },
      cyclicNoteVisible: false,
    },
    cyclicStory: buildCyclicStoryView?.(null, {
      phase: 2,
      phaseText: "进行期（阶段2）",
      scoreItemName: "花史残页",
      score: 10,
      expOrderNum: 1,
      expOrderMax: 3,
      orders: [],
    }, { autoSubmitEnabled: false, hasProfile: true }),
    teamOrderSettings: {
      hasProfile: true,
      triggerReleaseEnabled: false,
      triggerMode: "protected",
      doubleGoldRemaining: "-",
      paidRenewReleaseEnabled: false,
      guardMultiplier: "2",
      guardMultiplierBusy: false,
      guardFormulaText: "暂无组团经验历史",
    },
  };
}

function withValue(view, path, value) {
  const next = structuredClone(view);
  let target = next;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = value;
  return next;
}

function createFixture() {
  const document = new FakeDocument();
  const writes = [];
  const structuralWrites = [];
  document.writes = writes;
  document.structuralWrites = structuralWrites;
  const nodes = {};
  for (const id of [
    "queueTabCommon",
    "queueTabSecondary",
    "queueTabActivities",
    "queueTabCyclicNote",
    "queueTabTeamOrders",
    "queueCycleValue",
    "queueStepValue",
    "automationStopBanner",
    "automationStopTitle",
    "automationStopMessage",
    "queueMatrix",
    "teamOrderPanel",
    "teamOrderProtectionControl",
  ]) {
    nodes[id] = document.createElement("div");
    nodes[id].id = id;
    document.body.append(nodes[id]);
  }
  for (const [id, tab] of [
    ["queueTabCommon", "common"],
    ["queueTabSecondary", "secondary"],
    ["queueTabActivities", "activities"],
    ["queueTabCyclicNote", "cyclic-note"],
    ["queueTabTeamOrders", "team-orders"],
  ]) nodes[id].setAttribute("data-queue-tab", tab);
  writes.length = 0;
  structuralWrites.length = 0;
  return {
    document,
    nodes,
    writes,
    structuralWrites,
    getNode: (id) => nodes[id] || findById(document.body, id),
    clearWrites() {
      writes.length = 0;
      structuralWrites.length = 0;
    },
  };
}

class FakeDocument {
  constructor() {
    this.writes = [];
    this.structuralWrites = [];
    this.activeElement = null;
    this.body = new FakeElement("body", this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = "";
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this.listeners = new Map();
    this._textContent = "";
    this._hidden = false;
    this._disabled = false;
    this._checked = false;
    this._value = "";
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, enabled) => {
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        this.ownerDocument.writes.push({ node: this, kind: "class-toggle", name, value: Boolean(enabled) });
      },
    };
  }

  get textContent() { return this._textContent; }
  set textContent(value) {
    if (this.children.length) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.ownerDocument.structuralWrites.push({ kind: "text-replace", node: this });
    }
    this.writeProperty("textContent", String(value));
  }
  get hidden() { return this._hidden; }
  set hidden(value) { this.writeProperty("hidden", Boolean(value)); }
  get disabled() { return this._disabled; }
  set disabled(value) { this.writeProperty("disabled", Boolean(value)); }
  get checked() { return this._checked; }
  set checked(value) { this.writeProperty("checked", Boolean(value)); }
  get value() { return this._value; }
  set value(value) { this.writeProperty("value", String(value)); }

  writeProperty(name, value) {
    this[`_${name}`] = value;
    this.ownerDocument.writes.push({ node: this, kind: "property", name, value });
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) node.parentNode.removeChild(node, { moving: true });
      this.children.push(node);
      node.parentNode = this;
      this.ownerDocument.structuralWrites.push({ kind: "insert", parent: this, node });
    }
  }

  removeChild(node, options = {}) {
    const index = this.children.indexOf(node);
    assert.ok(index >= 0);
    this.children.splice(index, 1);
    node.parentNode = null;
    if (!options.moving) this.ownerDocument.structuralWrites.push({ kind: "remove", parent: this, node });
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    if (name === "id") this.id = normalized;
    this.ownerDocument.writes.push({ node: this, kind: "attribute-set", name, value: normalized });
  }
  removeAttribute(name) {
    this.attributes.delete(name);
    this.ownerDocument.writes.push({ node: this, kind: "attribute-remove", name });
  }
  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this });
  }
  set innerHTML(_value) { throw new Error("T4 fixed renderer must not use innerHTML"); }
}

function findById(root, id) {
  if (root.id === id) return root;
  for (const child of root.children) {
    const match = findById(child, id);
    if (match) return match;
  }
  return null;
}

function findByAttribute(root, name, value) {
  if (root.getAttribute(name) === value) return root;
  for (const child of root.children) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

function findAllByAttribute(root, name) {
  const matches = [];
  if (root.getAttribute(name) !== null) matches.push(root);
  for (const child of root.children) matches.push(...findAllByAttribute(child, name));
  return matches;
}

function assertDomRecords(actual, expected, message) {
  assert.deepEqual(
    actual.map(normalizeDomRecord),
    expected.map(normalizeDomRecord),
    message,
  );
}

function normalizeDomRecord(record) {
  const normalized = { ...record };
  if ("parent" in normalized) normalized.parent = describeDomNode(normalized.parent);
  if ("node" in normalized) normalized.node = describeDomNode(normalized.node);
  return normalized;
}

function describeDomNode(node) {
  if (!node || typeof node !== "object") return node;
  if (node.id) return `#${node.id}`;
  for (const attribute of [
    "data-cyclic-story-field",
    "data-queue-field",
    "data-queue-card",
    "data-cyclic-story-slot",
  ]) {
    const value = node.getAttribute?.(attribute);
    if (value !== null && value !== undefined) {
      return `${node.tagName || "node"}[${attribute}=${value}]`;
    }
  }
  return node.tagName || "node";
}

function functionSlice(script, startName, endName, required = true) {
  const start = script.indexOf(`function ${startName}`);
  const end = script.indexOf(`function ${endName}`);
  if (!required && start < 0) return "";
  assert.ok(start >= 0, `${startName} must exist`);
  assert.ok(end > start, `${endName} must follow ${startName}`);
  return script.slice(start, end);
}
