import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewModule = await import("./system/public/cyclic-story-view.js").catch(() => ({}));
const { buildCyclicStoryView, createCyclicStoryRenderer } = viewModule;

test("T4 cyclic-story view keeps row priority and exposes every activity value", () => {
  assert.equal(typeof buildCyclicStoryView, "function");
  assert.equal(typeof createCyclicStoryRenderer, "function");
  const fallback = story({ score: 7, scoreItemName: "回退积分" });
  const rowStory = story({
    score: 21,
    scoreItemName: "花史残页",
    phaseRemainingMs: 65_000,
    orders: [order({ status: "ready" })],
  });

  const view = buildCyclicStoryView({
    state: "blocked",
    pending: 2,
    status: "队列状态优先",
    cyclicStory: rowStory,
  }, fallback);

  assert.deepEqual({
    cardState: view.cardState,
    pendingCount: view.pendingCount,
    phase: view.phase,
    phaseText: view.phaseText,
    phaseStatus: view.phaseStatus,
    phaseRemaining: view.phaseRemaining,
    orderCount: view.orderCount,
    scoreItemName: view.scoreItemName,
    score: view.score,
    expCurrent: view.expCurrent,
    expMax: view.expMax,
  }, {
    cardState: "blocked",
    pendingCount: "2",
    phase: 2,
    phaseText: "进行期（阶段2）",
    phaseStatus: "队列状态优先",
    phaseRemaining: "0天00时01分05秒",
    orderCount: "1",
    scoreItemName: "花史残页",
    score: "21",
    expCurrent: "12",
    expMax: "400",
  });
  assert.equal(view.slots.length, 3);
  assert.equal(view.slots[0].mode, "order");
  assert.equal(view.slots[1].mode, "empty");
  assert.equal(view.slots[2].mode, "empty");
});

test("phase remaining uses day-hour-minute-second copy without changing order cooldown", () => {
  const view = buildCyclicStoryView(null, story({
    phaseRemainingMs: 1_149_137_000,
    orders: [order({ remainingMs: 65_000 })],
  }));

  assert.equal(view.phaseRemaining, "13天07时12分17秒");
  assert.equal(view.slots[0].cooldown, "01:05");
});

test("T4 cyclic-story fallback and phase branches preserve current copy semantics", () => {
  const cases = [
    [0, "未开放（阶段0）", "尚未进入预告期", "尚未开放", "等待活动预告"],
    [1, "预告期（阶段1）", "活动尚未开始；进入阶段2后刷新订单", "预告期", "活动开始后刷新订单"],
    [3, "兑换期（阶段3）", "订单提交已结束；当前仅为兑换期", "提交已结束", "该阶段不再显示订单"],
    [4, "已结束（阶段4）", "活动已结束，不能提交", "活动已结束", "等待下一期活动"],
  ];
  for (const [phase, phaseText, phaseStatus, slotStatus, slotText] of cases) {
    const view = buildCyclicStoryView({ pending: null, status: "不应覆盖非进行期" }, story({
      phase,
      pendingAutoSubmitActions: [{ id: 1 }],
      orders: [order()],
    }));
    assert.equal(view.phaseText, phaseText);
    assert.equal(view.phaseStatus, phaseStatus);
    assert.equal(view.pendingCount, "1");
    assert.equal(view.orderCount, "0");
    assert.equal(view.slots.every((slot) => slot.mode === "inactive"), true);
    assert.equal(view.slots[0].statusText, slotStatus);
    assert.equal(view.slots[0].messageText, slotText);
  }

  const unknown = buildCyclicStoryView(null, story({
    phase: "unknown",
    phaseRemainingMs: null,
    phaseText: "服务端阶段",
    reasonText: "活动时间不可用",
  }));
  assert.equal(unknown.phase, "unknown");
  assert.equal(unknown.phaseText, "服务端阶段");
  assert.equal(unknown.phaseStatus, "活动时间不可用");
  assert.equal(unknown.phaseRemaining, "--:--");
});

test("fixed activity card and three slots retain identity on equal fresh snapshots", () => {
  const fixture = createFixture();
  const renderer = createCyclicStoryRenderer(fixture.document);
  const input = story({ orders: [order(), order({ flowerId: 23002 }), order({ flowerId: 23003 })] });
  const view = buildCyclicStoryView({ pending: 1, status: "可提交 1" }, input);
  renderer.render(view);
  const root = renderer.root;
  const slots = findAllByAttribute(root, "data-cyclic-story-slot");
  const leaves = findAllByAttribute(root, "data-cyclic-story-field");
  fixture.clearWrites();

  renderer.render(buildCyclicStoryView(
    { pending: 1, status: "可提交 1" },
    structuredClone(input),
  ));

  assert.strictEqual(renderer.root, root);
  assert.equal(slots.length, 3);
  assert.deepEqual(findAllByAttribute(root, "data-cyclic-story-slot"), slots);
  assert.deepEqual(findAllByAttribute(root, "data-cyclic-story-field"), leaves);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("activity and slot fields use the smallest necessary writes", () => {
  const fixture = createFixture();
  const renderer = createCyclicStoryRenderer(fixture.document);
  const baseStory = story({ orders: [order()] });
  renderer.render(buildCyclicStoryView({ pending: 0, status: "可提交 0" }, baseStory));
  const score = findField(renderer.root, "score");
  const cooldown = findField(renderer.root, "slot-1-cooldown");
  const headlineCost = findField(renderer.root, "slot-1-headline-cost");
  const demand = findField(renderer.root, "slot-1-demand");

  fixture.clearWrites();
  renderer.render(buildCyclicStoryView({ pending: 0, status: "可提交 0" }, {
    ...baseStory,
    score: 22,
  }));
  assert.deepEqual(fixture.writes, [propertyWrite(score, "22")]);
  assert.deepEqual(fixture.structuralWrites, []);

  fixture.clearWrites();
  renderer.render(buildCyclicStoryView({ pending: 0, status: "可提交 0" }, {
    ...baseStory,
    score: 22,
    orders: [{ ...baseStory.orders[0], remainingMs: 60_001 }],
  }));
  assert.deepEqual(fixture.writes, [propertyWrite(cooldown, "01:01")]);

  fixture.clearWrites();
  renderer.render(buildCyclicStoryView({ pending: 0, status: "可提交 0" }, {
    ...baseStory,
    score: 22,
    orders: [{ ...baseStory.orders[0], remainingMs: 60_001, cost: 81 }],
  }));
  assert.deepEqual(fixture.writes, [
    propertyWrite(headlineCost, "81"),
    propertyWrite(demand, "81"),
  ]);
});

test("every independent activity value patches only its own leaf", () => {
  const cases = [
    [{ phaseRemainingMs: 119_000 }, {}, "phase-remaining", "0天00时01分59秒"],
    [{ scoreItemName: "新积分名" }, {}, "score-name", "新积分名"],
    [{ score: 22 }, {}, "score", "22"],
    [{ expOrderNum: 13 }, {}, "exp-current", "13"],
    [{ expOrderMax: 401 }, {}, "exp-max", "401"],
    [{}, { status: "新的队列状态" }, "phase-status", "新的队列状态"],
  ];
  for (const [storyOverrides, rowOverrides, field, expected] of cases) {
    const fixture = createFixture();
    const renderer = createCyclicStoryRenderer(fixture.document);
    const baseStory = story({ orders: [order()] });
    renderer.render(buildCyclicStoryView({ pending: 0, status: "原队列状态" }, baseStory));
    const target = findField(renderer.root, field);
    fixture.clearWrites();
    renderer.render(buildCyclicStoryView(
      { pending: 0, status: "原队列状态", ...rowOverrides },
      { ...baseStory, ...storyOverrides },
    ));
    assert.deepEqual(fixture.writes, [propertyWrite(target, expected)], field);
    assert.deepEqual(fixture.structuralWrites, [], field);
  }
});

test("every independent order value patches only its own visible leaf", () => {
  const cases = [
    [{ flowerName: "红玫瑰" }, "slot-1-flower-name", "红玫瑰"],
    [{ flowerId: 23002 }, "slot-1-flower-id", "23002"],
    [{ have: 99 }, "slot-1-inventory", "99"],
    [{ rewards: [{ name: "花史残页", count: 9 }] }, "slot-1-page", "9"],
    [{ expectedExperience: 999 }, "slot-1-experience", "999"],
    [{ expectedGold: 799 }, "slot-1-gold", "799"],
    [{ statusText: "服务端完整状态" }, "slot-1-status-generic", "服务端完整状态"],
  ];
  for (const [orderOverrides, field, expected] of cases) {
    const fixture = createFixture();
    const renderer = createCyclicStoryRenderer(fixture.document);
    const baseOrder = order();
    const baseStory = story({ orders: [baseOrder] });
    renderer.render(buildCyclicStoryView(null, baseStory));
    const target = findField(renderer.root, field);
    fixture.clearWrites();
    renderer.render(buildCyclicStoryView(null, {
      ...baseStory,
      orders: [{ ...baseOrder, ...orderOverrides }],
    }));
    assert.deepEqual(fixture.writes, [propertyWrite(target, expected)], field);
    assert.deepEqual(fixture.structuralWrites, [], field);
  }

  const fixture = createFixture();
  const renderer = createCyclicStoryRenderer(fixture.document);
  const shortage = order({ status: "inventory-shortage", missing: 2 });
  const baseStory = story({ orders: [shortage] });
  renderer.render(buildCyclicStoryView(null, baseStory));
  const missing = findField(renderer.root, "slot-1-missing");
  fixture.clearWrites();
  renderer.render(buildCyclicStoryView(null, {
    ...baseStory,
    orders: [{ ...shortage, missing: 3 }],
  }));
  assert.deepEqual(fixture.writes, [propertyWrite(missing, "3")]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("pending classes and order status branches patch without structural replacement", () => {
  const fixture = createFixture();
  const renderer = createCyclicStoryRenderer(fixture.document);
  renderer.render(buildCyclicStoryView({ pending: 0 }, story({ orders: [] })));
  const root = renderer.root;
  const slots = findAllByAttribute(root, "data-cyclic-story-slot");
  fixture.clearWrites();

  renderer.render(buildCyclicStoryView({ pending: 1 }, story({
    orders: [order({ status: "inventory-shortage", missing: 3 })],
  })));

  assert.equal(root.classList.contains("pending"), true);
  assert.equal(root.classList.contains("idle"), false);
  assert.equal(slots[0].classList.contains("shortage"), true);
  assert.equal(findField(root, "slot-1-missing").textContent, "3");
  assert.equal(findField(root, "slot-2-empty-message").hidden, false);
  assert.deepEqual(findAllByAttribute(root, "data-cyclic-story-slot"), slots);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("phase changes and changing order counts never replace the fixed slots", () => {
  const fixture = createFixture();
  const renderer = createCyclicStoryRenderer(fixture.document);
  renderer.render(buildCyclicStoryView(null, story({ phase: 1, orders: [order()] })));
  const slots = findAllByAttribute(renderer.root, "data-cyclic-story-slot");
  fixture.clearWrites();

  for (const nextStory of [
    story({ phase: 2, orders: [] }),
    story({ phase: 2, orders: [order()] }),
    story({ phase: 2, orders: [order(), order({ flowerId: 23002 }), order({ flowerId: 23003 })] }),
    story({ phase: 3, orders: [order()] }),
    story({ phase: 4, orders: [] }),
    story({ phase: "unknown", orders: [] }),
  ]) {
    renderer.render(buildCyclicStoryView(null, nextStory));
    assert.deepEqual(findAllByAttribute(renderer.root, "data-cyclic-story-slot"), slots);
  }
  assert.deepEqual(fixture.structuralWrites, []);
});

test("dynamic story strings stay text-only and cooldown uses snapshot boundaries", () => {
  const unsafe = "<img src=x onerror=1>";
  const fixture = createFixture();
  const renderer = createCyclicStoryRenderer(fixture.document);
  const remainingCases = [
    [null, "--:--"],
    [0, "00:00"],
    [-1, "00:00"],
    [1, "00:01"],
    [60_001, "01:01"],
  ];

  for (const [remainingMs, expected] of remainingCases) {
    const view = buildCyclicStoryView({ status: unsafe }, story({
      scoreItemName: unsafe,
      orders: [order({ flowerName: unsafe, status: "unknown", statusText: unsafe, remainingMs })],
    }));
    renderer.render(view);
    assert.equal(findField(renderer.root, "score-name").textContent, unsafe);
    assert.equal(findField(renderer.root, "phase-status").textContent, unsafe);
    assert.equal(findField(renderer.root, "slot-1-flower-name").textContent, unsafe);
    assert.equal(findField(renderer.root, "slot-1-status-generic").textContent, unsafe);
    assert.equal(findField(renderer.root, "slot-1-cooldown").textContent, expected);
  }
});

test("cyclic-story renderer has no HTML replacement or independent clock", async () => {
  const source = await readFile("work/system/public/cyclic-story-view.js", "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|Date\.now/);
  assert.match(source, /规则：仅阶段2；冷却结束且库存充足时提交；每轮最多3单，不刷新\/付费/);
  for (const label of ["待提交", "阶段", "阶段剩余", "当前订单", "经验订单", "需求", "库存", "冷却", "残页", "经验", "金币"]) {
    assert.match(source, new RegExp(label));
  }
});

test("auto submit toggle fields follow the current profile setting over stale runtime status", () => {
  const options = { autoSubmitEnabled: true, hasProfile: true };
  const statusFirst = buildCyclicStoryView(null, story({ autoSubmitEnabled: false }), options);
  assert.equal(statusFirst.autoSubmitEnabled, true);
  assert.equal(statusFirst.enabledText, "开启");
  assert.equal(statusFirst.disabled, false);

  const optionFallback = buildCyclicStoryView(null, story({}), options);
  assert.equal(optionFallback.autoSubmitEnabled, true);
  assert.equal(optionFallback.enabledText, "开启");
  assert.equal(optionFallback.disabled, false);

  const noProfile = buildCyclicStoryView(null, story({}), { autoSubmitEnabled: true });
  assert.equal(noProfile.autoSubmitEnabled, true);
  assert.equal(noProfile.disabled, true);

  const defaults = buildCyclicStoryView(null, story({}));
  assert.equal(defaults.autoSubmitEnabled, false);
  assert.equal(defaults.enabledText, "关闭");
  assert.equal(defaults.disabled, true);
});

test("highest experience toggle fields follow the current profile setting over stale runtime status", () => {
  const options = {
    autoSubmitEnabled: true,
    onlyHighestExperienceEnabled: true,
    hasProfile: true,
  };
  const statusFirst = buildCyclicStoryView(
    null,
    story({ onlyHighestExperienceEnabled: false }),
    options,
  );
  assert.equal(statusFirst.onlyHighestExperienceEnabled, true);
  assert.equal(statusFirst.onlyHighestExperienceEnabledText, "开启");
  assert.equal(statusFirst.onlyHighestExperienceDisabled, false);
  assert.equal(statusFirst.disabled, false);

  const optionFallback = buildCyclicStoryView(null, story({}), options);
  assert.equal(optionFallback.onlyHighestExperienceEnabled, true);
  assert.equal(optionFallback.onlyHighestExperienceEnabledText, "开启");
  assert.equal(optionFallback.onlyHighestExperienceDisabled, false);

  const parentOff = buildCyclicStoryView(null, story({}), {
    autoSubmitEnabled: false,
    onlyHighestExperienceEnabled: true,
    hasProfile: true,
  });
  assert.equal(parentOff.onlyHighestExperienceEnabled, true);
  assert.equal(parentOff.onlyHighestExperienceDisabled, true);

  const defaults = buildCyclicStoryView(null, story({}));
  assert.equal(defaults.onlyHighestExperienceEnabled, false);
  assert.equal(defaults.onlyHighestExperienceEnabledText, "关闭");
  assert.equal(defaults.onlyHighestExperienceDisabled, true);
  assert.equal(defaults.disabled, true);
});

function story(overrides = {}) {
  return {
    phase: 2,
    phaseRemainingMs: 120_000,
    reasonText: "进行期：可提交订单",
    pendingAutoSubmitActions: [],
    scoreItemName: "花史残页",
    score: 21,
    expOrderNum: 12,
    expOrderMax: 400,
    orders: [],
    ...overrides,
  };
}

function order(overrides = {}) {
  return {
    status: "ready",
    statusText: "可提交",
    flowerName: "白百合",
    flowerId: 23001,
    cost: 80,
    have: 100,
    missing: 0,
    remainingMs: 5_000,
    rewards: [{ name: "花史残页", count: 8 }],
    expectedExperience: 1_000,
    expectedGold: 800,
    ...overrides,
  };
}

function createFixture() {
  const document = new FakeDocument();
  return {
    document,
    writes: document.writes,
    structuralWrites: document.structuralWrites,
    clearWrites() {
      document.writes.length = 0;
      document.structuralWrites.length = 0;
    },
  };
}

class FakeDocument {
  constructor() {
    this.writes = [];
    this.structuralWrites = [];
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this._textContent = "";
    this._hidden = false;
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      toggle: (name, enabled) => {
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
        this.ownerDocument.writes.push({ node: this, kind: "class-toggle", name, value: Boolean(enabled) });
      },
    };
  }

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    if (this.children.length) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.ownerDocument.structuralWrites.push({ kind: "text-replace", parent: this });
    }
    this._textContent = String(value);
    this.ownerDocument.writes.push({ node: this, kind: "property", name: "textContent", value: String(value) });
  }

  get hidden() {
    return this._hidden;
  }

  set hidden(value) {
    this._hidden = Boolean(value);
    this.ownerDocument.writes.push({ node: this, kind: "property", name: "hidden", value: Boolean(value) });
  }

  set innerHTML(_value) {
    throw new Error("cyclic story nodes must not use innerHTML");
  }

  replaceChildren() {
    throw new Error("cyclic story nodes must not use replaceChildren");
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentNode) throw new Error("test fixture does not support moving initialized story nodes");
      this.children.push(node);
      node.parentNode = this;
      this.ownerDocument.structuralWrites.push({ kind: "append", parent: this, node });
    }
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  setAttribute(name, value) {
    const normalized = String(value);
    this.attributes.set(name, normalized);
    this.ownerDocument.writes.push({ node: this, kind: "attribute-set", name, value: normalized });
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    this.ownerDocument.writes.push({ node: this, kind: "attribute-remove", name });
  }
}

function findField(root, field) {
  const match = findAllByAttribute(root, "data-cyclic-story-field", field)[0];
  assert.ok(match, `missing field ${field}`);
  return match;
}

function findAllByAttribute(root, name, value = undefined) {
  const matches = [];
  if (root.getAttribute(name) !== null && (value === undefined || root.getAttribute(name) === String(value))) {
    matches.push(root);
  }
  for (const child of root.children) matches.push(...findAllByAttribute(child, name, value));
  return matches;
}

function propertyWrite(node, value, name = "textContent") {
  return { node, kind: "property", name, value };
}
