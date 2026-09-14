import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const viewModule = await import("./system/public/upper-dashboard-view.js").catch(() => ({}));
const { createUpperDashboardRenderer } = viewModule;
const publicDir = path.join(import.meta.dirname, "system", "public");

const FIXED_NODE_IDS = [
  "servicePort",
  "servicePid",
  "refreshTime",
  "lockState",
  "gameVersionMeta",
  "localGameVersion",
  "remoteGameVersion",
  "gameCodeReviewState",
  "gameDataVersionMeta",
  "activeGameDataVersion",
  "activeGameDataSourceCodeVersion",
  "gameDataSyncState",
  "checkGameVersionButton",
  "syncGameDataButton",
  "gameDataSyncFeedback",
  "legacyBanner",
  "profileCountValue",
  "wizardPanel",
  "wizardBadge",
  "wizardTitle",
  "wizardCopyLoading",
  "wizardCopyMissing",
  "wizardCopyInvalid",
  "wizardValidationError",
  "wizardCopyReadyValidated",
  "wizardValidatedAt",
  "wizardCopyReadyUnvalidated",
  "wizardCopyLegacyFound",
  "wizardMigrationProfileId",
  "wizardCopyProfileMissing",
  "wizardCopyLegacyIncomplete",
  "wizardMissing",
  "migrateLegacyButton",
  "validateProfileButton",
  "openImportButton",
  "selectedProfileLabel",
  "selectedProfileIdWrap",
  "selectedProfileIdValue",
  "taskMode",
  "taskPid",
  "taskStartedAt",
  "nextRunText",
  "startButton",
  "onceButton",
  "ordersButton",
  "stopButton",
  "resetCredentialsButton",
  "statusAgeLabel",
  "statusAgeValue",
  "landTotal",
  "landEmpty",
  "landGrowing",
  "landMature",
  "nextMatureText",
  "waterDropText",
  "waterNextText",
  "waterNeedText",
  "resourceGoldValue",
  "resourcePearlValue",
  "resourceFlowerShopCoinValue",
  "resourceSatinSilkValue",
  "resourceBuildingMaterialValue",
  "resourceYuanbaoValue",
  "resourceHireItemCountValue",
  "riskErrorsMetric",
  "riskErrorsValue",
  "riskStatusMetric",
  "riskStatusValue",
  "riskLoginMetric",
  "riskLoginValue",
  "riskCredentialsMetric",
  "riskCredentialsValue",
  "accountServerSummaryValue",
  "accountLevelValueSummaryValue",
  "accountExperienceSummaryValue",
  "artifactLinks",
  "artifactStatusPageLink",
  "artifactStatusJsonLink",
  "artifactOrderJsonLink",
];

test("T2 exposes a cached upper-dashboard renderer and static HTML nodes", async () => {
  assert.equal(typeof createUpperDashboardRenderer, "function");
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");

  for (const id of FIXED_NODE_IDS) {
    const matches = html.match(new RegExp(`id=["']${id}["']`, "g")) || [];
    assert.equal(matches.length, 1, `${id} must exist exactly once`);
  }
  for (const label of [
    "金币",
    "珍珠",
    "花坊币",
    "丝绸",
    "建材",
    "元宝",
    "雇佣卡",
    "错误数",
    "登录态",
    "凭据",
    "状态页",
    "状态 JSON",
    "订单 JSON",
  ]) {
    assert.match(html, new RegExp(label));
  }
});

test("T2 fixed renderers do not retain full-container HTML rebuilds", async () => {
  const script = await readFile(path.join(publicDir, "app.js"), "utf8");
  const summaryRenderer = functionSlice(script, "renderSummary", "renderQueue");
  const levelRenderer = functionSlice(script, "renderAccountLevelSummary", "renderArtifactLinks");
  const artifactRenderer = functionSlice(script, "renderArtifactLinks", "renderTeamOrders");

  assert.doesNotMatch(summaryRenderer, /resourceGrid[^\n]*innerHTML|riskGrid[^\n]*innerHTML/);
  assert.doesNotMatch(levelRenderer, /innerHTML/);
  assert.doesNotMatch(artifactRenderer, /innerHTML/);
});

test("same upper-dashboard snapshot keeps node identity and performs zero writes", () => {
  const fixture = createTrackedFixture();
  const renderer = createUpperDashboardRenderer(fixture.getNode);
  const view = createUpperDashboardView();
  const references = new Map(FIXED_NODE_IDS.map((id) => [id, fixture.peekNode(id)]));

  renderUpperDashboard(renderer, view);
  fixture.clearWrites();
  renderUpperDashboard(renderer, view);

  assert.deepEqual(fixture.writes, []);
  for (const [id, reference] of references) {
    assert.strictEqual(fixture.peekNode(id), reference, id);
    assert.equal(fixture.queryCount.get(id), 1, `${id} should be cached after construction`);
  }
});

test("changing only land empty count writes only the target value node", () => {
  const fixture = createTrackedFixture();
  const renderer = createUpperDashboardRenderer(fixture.getNode);
  const view = createUpperDashboardView();
  renderUpperDashboard(renderer, view);
  fixture.clearWrites();

  renderer.renderSummary({
    ...view.summary,
    landEmpty: "2",
  });

  assert.deepEqual(fixture.writes, [{
    target: "landEmpty",
    kind: "property",
    name: "textContent",
    value: "2",
  }]);
});

test("code and data version fragments patch independently", () => {
  const fixture = createTrackedFixture();
  const renderer = createUpperDashboardRenderer(fixture.getNode);
  const view = createUpperDashboardView();
  renderUpperDashboard(renderer, view);
  fixture.clearWrites();

  renderer.renderGameVersion({
    ...view.gameVersion,
    data: {
      ...view.gameVersion.data,
      state: "same",
      activeVersion: "abc12",
      sourceCodeVersion: "400.0.15",
      statusText: "最新",
      title: "当前启用数据 abc12",
    },
  });

  assert.deepEqual(new Set(fixture.writes.map((entry) => entry.target)), new Set([
    "gameDataVersionMeta",
    "activeGameDataVersion",
    "activeGameDataSourceCodeVersion",
    "gameDataSyncState",
  ]));
  assert.equal(fixture.writes.some((entry) => ["gameVersionMeta", "localGameVersion", "remoteGameVersion", "gameCodeReviewState"].includes(entry.target)), false);
});

test("each resource and account level field writes only its own value node", () => {
  const resourceCases = [
    ["gold", "resourceGoldValue"],
    ["pearl", "resourcePearlValue"],
    ["flowerShopCoin", "resourceFlowerShopCoinValue"],
    ["satinSilk", "resourceSatinSilkValue"],
    ["buildingMaterial", "resourceBuildingMaterialValue"],
    ["yuanbao", "resourceYuanbaoValue"],
    ["hireItemCount", "resourceHireItemCountValue"],
  ];
  for (const [field, target] of resourceCases) {
    const fixture = createTrackedFixture();
    const renderer = createUpperDashboardRenderer(fixture.getNode);
    const view = createUpperDashboardView();
    renderUpperDashboard(renderer, view);
    fixture.clearWrites();
    renderer.renderSummary({
      ...view.summary,
      resources: { ...view.summary.resources, [field]: `${field}-changed` },
    });
    assert.deepEqual(fixture.writes, [{
      target,
      kind: "property",
      name: "textContent",
      value: `${field}-changed`,
    }], field);
  }

  for (const [field, target] of [
    ["server", "accountServerSummaryValue"],
    ["level", "accountLevelValueSummaryValue"],
    ["experience", "accountExperienceSummaryValue"],
  ]) {
    const fixture = createTrackedFixture();
    const renderer = createUpperDashboardRenderer(fixture.getNode);
    const view = createUpperDashboardView();
    renderUpperDashboard(renderer, view);
    fixture.clearWrites();
    renderer.renderAccountLevel({ ...view.accountLevel, [field]: `${field}-changed` });
    assert.deepEqual(fixture.writes, [{
      target,
      kind: "property",
      name: "textContent",
      value: `${field}-changed`,
    }], field);
  }
});

test("wizard validation time and risk state update only their own fragments", () => {
  const fixture = createTrackedFixture();
  const renderer = createUpperDashboardRenderer(fixture.getNode);
  const view = createUpperDashboardView();
  renderUpperDashboard(renderer, view);
  fixture.clearWrites();

  renderer.renderWizard({
    ...view.wizard,
    validatedAt: "08-04 12:00",
  });
  assert.deepEqual(fixture.writes, [{
    target: "wizardValidatedAt",
    kind: "property",
    name: "textContent",
    value: "08-04 12:00",
  }]);

  fixture.clearWrites();
  renderer.renderSummary({
    ...view.summary,
    risks: {
      ...view.summary.risks,
      errors: { value: "1", state: "danger" },
    },
  });
  assert.deepEqual(fixture.writes, [
    {
      target: "riskErrorsValue",
      kind: "property",
      name: "textContent",
      value: "1",
    },
    {
      target: "riskErrorsMetric",
      kind: "class-toggle",
      name: "ok",
      value: false,
    },
    {
      target: "riskErrorsMetric",
      kind: "class-toggle",
      name: "danger",
      value: true,
    },
  ]);
});

test("artifact links retain identity and only patch account paths or visibility", () => {
  const fixture = createTrackedFixture();
  const renderer = createUpperDashboardRenderer(fixture.getNode);
  const view = createUpperDashboardView();
  renderer.renderArtifacts(view.artifacts);
  const statusLink = fixture.peekNode("artifactStatusPageLink");
  const jsonLink = fixture.peekNode("artifactStatusJsonLink");
  const orderLink = fixture.peekNode("artifactOrderJsonLink");
  fixture.clearWrites();

  renderer.renderArtifacts({
    visible: true,
    statusPageHref: "/artifacts/p2/garden-status.html",
    statusJsonHref: "/artifacts/p2/garden-status.json",
    orderJsonHref: "/artifacts/p2/order-status.json",
  });

  assert.strictEqual(fixture.peekNode("artifactStatusPageLink"), statusLink);
  assert.strictEqual(fixture.peekNode("artifactStatusJsonLink"), jsonLink);
  assert.strictEqual(fixture.peekNode("artifactOrderJsonLink"), orderLink);
  assert.deepEqual(fixture.writes.map(({ target, kind, name }) => ({ target, kind, name })), [
    { target: "artifactStatusPageLink", kind: "attribute-set", name: "href" },
    { target: "artifactStatusJsonLink", kind: "attribute-set", name: "href" },
    { target: "artifactOrderJsonLink", kind: "attribute-set", name: "href" },
  ]);

  fixture.clearWrites();
  renderer.renderArtifacts({
    visible: false,
    statusPageHref: null,
    statusJsonHref: null,
    orderJsonHref: null,
  });
  assert.deepEqual(fixture.writes.map(({ target, kind, name }) => ({ target, kind, name })), [
    { target: "artifactLinks", kind: "property", name: "hidden" },
    { target: "artifactStatusPageLink", kind: "attribute-remove", name: "href" },
    { target: "artifactStatusJsonLink", kind: "attribute-remove", name: "href" },
    { target: "artifactOrderJsonLink", kind: "attribute-remove", name: "href" },
  ]);
});

function renderUpperDashboard(renderer, view) {
  renderer.renderRuntime(view.runtime);
  renderer.renderGameVersion(view.gameVersion);
  renderer.renderLegacyShell(view.legacy);
  renderer.renderProfileCount(view.profileCount);
  renderer.renderWizard(view.wizard);
  renderer.renderTask(view.task);
  renderer.renderSummary(view.summary);
  renderer.renderAccountLevel(view.accountLevel);
  renderer.renderArtifacts(view.artifacts);
}

function createUpperDashboardView() {
  return {
    runtime: {
      servicePort: "8787",
      servicePid: "1234",
      refreshTime: "11:00:00",
      lockState: "正常",
    },
    gameVersion: {
      code: {
        state: "same",
        localVersion: "391.0.25",
        officialVersion: "391.0.25",
        statusText: "已是最新",
        title: "当前运行版本已是官方最新版本",
      },
      data: {
        state: "current",
        activeVersion: "2f3f6",
        sourceCodeVersion: "391.0.25",
        statusText: "当前启用",
        title: "当前启用数据 2f3f6",
      },
      checkButton: {
        disabled: false,
        text: "检查游戏官方版本",
        title: "当前运行版本已是官方最新版本",
      },
      syncButton: {
        disabled: false,
        text: "同步最新版游戏代码和数据",
        title: "当前启用数据 2f3f6",
      },
      feedback: {
        visible: false,
        state: "neutral",
        text: "",
      },
    },
    legacy: { visible: false },
    profileCount: { value: "2" },
    wizard: {
      state: "ready",
      badgeText: "可运行",
      badgeState: "ready",
      title: "账号可用",
      copyState: "ready-validated",
      validationError: "",
      validatedAt: "08-04 11:00",
      migrationProfileId: "旧账号",
      missingVisible: false,
      migrateDisabled: true,
      validateDisabled: false,
      importPrimary: false,
    },
    task: {
      profileName: "主号",
      profileId: "p1",
      hasProfile: true,
      mode: "待命",
      pid: "-",
      startedAt: "-",
      doubleGoldRemaining: "未开启",
      startDisabled: false,
      onceDisabled: false,
      ordersDisabled: false,
      stopDisabled: true,
      resetDisabled: false,
    },
    summary: {
      statusLabel: "已刷新",
      statusValue: "2026/08/04 11:00:00",
      landTotal: "16",
      landEmpty: "1",
      landGrowing: "15",
      landMature: "0",
      nextMature: "1分30秒",
      waterDrop: "20/65",
      waterNext: "2分00秒",
      waterNeed: "当前补种需要 16",
      resources: {
        gold: "1万",
        pearl: "20",
        flowerShopCoin: "30",
        satinSilk: "40",
        buildingMaterial: "50",
        yuanbao: "60",
        hireItemCount: "70",
      },
      risks: {
        errors: { value: "0", state: "ok" },
        status: { value: "已刷新", state: "ok" },
        login: { value: "正常", state: "ok" },
        credentials: { value: "完整", state: "ok" },
      },
    },
    accountLevel: {
      server: "726",
      level: "40",
      experience: "276,0828/991,9000（27.8%）",
    },
    artifacts: {
      visible: true,
      statusPageHref: "/artifacts/p1/garden-status.html",
      statusJsonHref: "/artifacts/p1/garden-status.json",
      orderJsonHref: "/artifacts/p1/order-status.json",
    },
  };
}

function createTrackedFixture() {
  const nodes = new Map();
  const queryCount = new Map();
  const writes = [];
  const getNode = (id) => {
    queryCount.set(id, (queryCount.get(id) || 0) + 1);
    if (!nodes.has(id)) nodes.set(id, createTrackedNode(id, writes));
    return nodes.get(id);
  };
  return {
    getNode,
    queryCount,
    writes,
    peekNode(id) {
      return nodes.get(id);
    },
    clearWrites() {
      writes.length = 0;
    },
  };
}

function createTrackedNode(target, writes) {
  const values = {
    textContent: "",
    hidden: false,
    disabled: false,
  };
  const attributes = new Map();
  const classes = new Set();
  const node = {
    getAttribute(name) {
      return attributes.has(name) ? attributes.get(name) : null;
    },
    setAttribute(name, value) {
      const normalizedValue = String(value);
      attributes.set(name, normalizedValue);
      writes.push({ target, kind: "attribute-set", name, value: normalizedValue });
    },
    removeAttribute(name) {
      attributes.delete(name);
      writes.push({ target, kind: "attribute-remove", name, value: null });
    },
    classList: {
      contains(name) {
        return classes.has(name);
      },
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
        writes.push({ target, kind: "class-toggle", name, value: Boolean(enabled) });
      },
    },
  };
  for (const propertyName of ["textContent", "hidden", "disabled"]) {
    Object.defineProperty(node, propertyName, {
      get() {
        return values[propertyName];
      },
      set(value) {
        values[propertyName] = value;
        writes.push({ target, kind: "property", name: propertyName, value });
      },
    });
  }
  for (const propertyName of ["innerHTML", "replaceChildren"]) {
    Object.defineProperty(node, propertyName, {
      set() {
        throw new Error(`T2 fixed node ${target} must not use ${propertyName}`);
      },
    });
  }
  return node;
}

function functionSlice(script, startName, endName) {
  const start = script.indexOf(`function ${startName}`);
  const end = script.indexOf(`function ${endName}`);
  assert.ok(start >= 0, `${startName} must exist`);
  assert.ok(end > start, `${endName} must follow ${startName}`);
  return script.slice(start, end);
}
