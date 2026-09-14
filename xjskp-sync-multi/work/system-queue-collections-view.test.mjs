import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewModule = await import("./system/public/queue-collections-view.js").catch(() => ({}));
const { createQueueCollectionsRenderer } = viewModule;

test("T5 exposes queue collection renderer without HTML replacement or an independent clock", async () => {
  assert.equal(typeof createQueueCollectionsRenderer, "function");
  const source = await readFile("work/system/public/queue-collections-view.js", "utf8");
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);
  assert.doesNotMatch(source, /setInterval|setTimeout|requestAnimationFrame|Date\.now/);
});

test("ordinary resident slots stay fixed by boxId and equal snapshots perform zero writes", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  const view = ordinaryView([
    orderSlot(1),
    refillSlot(3, { remainingSeconds: "12" }),
    videoSlot(6),
  ]);
  renderer.renderOrdinary(view);
  const slots = findAllByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot");
  assert.deepEqual(slots.map((slot) => slot.getAttribute("data-ordinary-resident-slot")), ["1", "2", "3", "4", "5", "6"]);
  fixture.clearWrites();

  renderer.renderOrdinary(structuredClone(view));

  assert.deepEqual(findAllByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot"), slots);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("ordinary refill countdown changes only its seconds leaf", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderOrdinary(ordinaryView([refillSlot(2, { remainingSeconds: "12" })]));
  const seconds = findByAttribute(
    fixture.nodes.ordinaryResidentSlotsHost,
    "data-ordinary-resident-field",
    "slot-2-refill-seconds",
  );
  assert.ok(seconds);
  fixture.clearWrites();

  renderer.renderOrdinary(ordinaryView([refillSlot(2, { remainingSeconds: "7" })]));

  assert.deepEqual(fixture.writes, [propertyWrite(seconds, "7")]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("ordinary input order, additions, and removals never replace the six boxId shells", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderOrdinary(ordinaryView([orderSlot(4), refillSlot(1)]));
  const slots = findAllByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot");
  fixture.clearWrites();

  renderer.renderOrdinary(ordinaryView([refillSlot(1), orderSlot(4)]));
  assert.deepEqual(findAllByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot"), slots);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);

  renderer.renderOrdinary(ordinaryView([videoSlot(5), refillSlot(1)]));
  assert.deepEqual(findAllByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot"), slots);
  assert.strictEqual(findByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot", "1"), slots[0]);
  assert.strictEqual(findByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot", "5"), slots[4]);
  assert.equal(slots[3].parentNode, fixture.nodes.ordinaryResidentSlotsHost);
});

test("ordinary flower items use itemId plus same-item occurrence and reconcile minimally", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  const first = orderSlot(1, {
    requirements: [
      flower(23001, "白百合", "5"),
      flower(23002, "红玫瑰", "6"),
      flower(23001, "白百合（追加）", "7"),
    ],
  });
  renderer.renderOrdinary(ordinaryView([first]));
  const slot = findByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-slot", "1");
  const itemA1 = findByAttribute(slot, "data-ordinary-resident-item-key", "23001:1");
  const itemB = findByAttribute(slot, "data-ordinary-resident-item-key", "23002:1");
  const itemA2 = findByAttribute(slot, "data-ordinary-resident-item-key", "23001:2");
  assert.ok(itemA1 && itemB && itemA2);
  const needB = findByAttribute(itemB, "data-ordinary-resident-item-field", "need");
  fixture.clearWrites();

  renderer.renderOrdinary(ordinaryView([orderSlot(1, {
    requirements: [
      flower(23001, "白百合", "5"),
      flower(23002, "红玫瑰", "8"),
      flower(23001, "白百合（追加）", "7"),
    ],
  })]));
  assert.deepEqual(fixture.writes, [propertyWrite(needB, "8")]);
  assert.deepEqual(fixture.structuralWrites, []);
  fixture.clearWrites();

  renderer.renderOrdinary(ordinaryView([orderSlot(1, {
    requirements: [
      flower(23002, "红玫瑰", "8"),
      flower(23001, "白百合", "5"),
      flower(23001, "白百合（追加）", "7"),
    ],
  })]));
  assert.deepEqual(
    findAllByAttribute(slot, "data-ordinary-resident-item-key"),
    [itemB, itemA1, itemA2],
  );
  assert.equal(fixture.structuralWrites.length, 1);
  fixture.clearWrites();

  renderer.renderOrdinary(ordinaryView([orderSlot(1, {
    requirements: [
      flower(23002, "红玫瑰", "8"),
      flower(23001, "白百合", "5"),
      flower(23003, "黄玫瑰", "9"),
    ],
  })]));
  const itemC = findByAttribute(slot, "data-ordinary-resident-item-key", "23003:1");
  assert.strictEqual(findByAttribute(slot, "data-ordinary-resident-item-key", "23002:1"), itemB);
  assert.strictEqual(findByAttribute(slot, "data-ordinary-resident-item-key", "23001:1"), itemA1);
  assert.ok(itemC);
  assert.equal(itemA2.parentNode, null);
});

test("cyclic-note card is conditionally added and removed without replacing its host", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  const host = fixture.nodes.cyclicNoteHost;
  renderer.renderCyclicNote(null);
  assert.equal(host.children.length, 0);
  fixture.clearWrites();

  renderer.renderCyclicNote(cyclicNoteView());
  const card = findByAttribute(host, "data-queue-card", "cyclic-note");
  assert.ok(card);
  assert.strictEqual(fixture.nodes.cyclicNoteHost, host);
  fixture.clearWrites();

  renderer.renderCyclicNote(structuredClone(cyclicNoteView()));
  assert.strictEqual(findByAttribute(host, "data-queue-card", "cyclic-note"), card);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);

  renderer.renderCyclicNote(null);
  assert.strictEqual(fixture.nodes.cyclicNoteHost, host);
  assert.equal(host.children.length, 0);
  assert.equal(card.parentNode, null);
});

test("cyclic-note uses a full-width keyed card with three spacious task panels", async () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderCyclicNote(cyclicNoteView());
  const card = findByAttribute(fixture.nodes.cyclicNoteHost, "data-queue-card", "cyclic-note");
  assert.equal(card.classList.contains("cyclic-note-queue-card"), true);
  assert.equal(card.children[0].classList.contains("cyclic-story-auto-submit-switch"), true);
  assert.equal(card.children[1].classList.contains("cyclic-story-highest-experience-switch"), true);
  assert.equal(card.children[2].classList.contains("cyclic-note-card-header"), true);
  assert.equal(findByAttribute(card, "id", "cyclicNoteAutomationToggle").checked, true);
  assert.equal(findByAttribute(card, "id", "cyclicNoteNaturalCompletionToggle").disabled, false);
  assert.ok(findByAttribute(card, "data-cyclic-note-field", "phase-remaining"));
  assert.equal(findByAttribute(card, "data-cyclic-note-field", "score").textContent, "21/80");
  assert.equal(
    findByAttribute(card, "data-cyclic-note-task-list", "true").classList.contains("cyclic-note-task-grid"),
    true,
  );

  const [view, styles] = await Promise.all([
    readFile("work/system/public/queue-collections-view.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);

  assert.match(view, /\["queue-card",\s*"cyclic-note-queue-card"\]/);
  assert.match(view, /\["cyclic-note-card-header"\]/);
  assert.match(view, /\["cyclic-note-task-list",\s*"cyclic-note-task-grid"\]/);
  assert.match(view, /\["queue-switch",\s*"cyclic-story-auto-submit-switch"\]/);
  assert.match(view, /\["queue-switch",\s*"cyclic-story-highest-experience-switch"\]/);
  assert.doesNotMatch(view, /cyclic-note-automation-switches|cyclic-note-parent-switch|cyclic-note-child-switch/);
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);
  assert.match(
    styles,
    /#queueMatrix\.queue-matrix-cyclic-note\s+\.queue-card\.cyclic-note-queue-card\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/s,
  );
  assert.match(
    styles,
    /\.cyclic-note-task-list\.cyclic-note-task-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    styles,
    /\.cyclic-note-card-header\s*>\s*\.queue-stats\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*900px\)[\s\S]*?\.cyclic-note-task-list\.cyclic-note-task-grid\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
});

test("cyclic-note child strategy is disabled when the parent automation is off", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderCyclicNote(cyclicNoteView({
    autoHandleEnabled: false,
    autoCompleteEnabled: true,
    autoCompleteDisabled: true,
  }));
  const parent = findByAttribute(fixture.nodes.cyclicNoteHost, "id", "cyclicNoteAutomationToggle");
  const child = findByAttribute(fixture.nodes.cyclicNoteHost, "id", "cyclicNoteNaturalCompletionToggle");
  assert.equal(parent.checked, false);
  assert.equal(child.checked, true);
  assert.equal(child.disabled, true);
  assert.equal(
    findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-field", "automation-enabled").textContent,
    "自动执行已关闭",
  );
});

test("cyclic-note task changes only the requested dynamic leaf", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  const view = cyclicNoteView({ tasks: [cyclicTask(1, 1001)] });
  renderer.renderCyclicNote(view);
  const task = findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-task-key", "1001:1");
  const progress = findByAttribute(task, "data-cyclic-note-task-field", "progress");
  fixture.clearWrites();

  renderer.renderCyclicNote({
    ...view,
    tasks: [cyclicTask(1, "1001", { progressText: "2/3" })],
  });

  assert.strictEqual(findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-task-key", "1001:1"), task);
  assert.deepEqual(fixture.writes, [propertyWrite(progress, "2/3")]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("cyclic-note tasks reconcile by taskId plus slot and fall back to the stable slot", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderCyclicNote(cyclicNoteView({
    tasks: [
      cyclicTask(1, 1001),
      cyclicTask(2, 1002),
      cyclicTask(3, null, { desc: "无任务 ID" }),
    ],
  }));
  const host = findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-task-list", "true");
  const task1 = findByAttribute(host, "data-cyclic-note-task-key", "1001:1");
  const task2 = findByAttribute(host, "data-cyclic-note-task-key", "1002:2");
  const fallback3 = findByAttribute(host, "data-cyclic-note-task-key", "slot:3");
  assert.ok(task1 && task2 && fallback3);
  fixture.clearWrites();

  renderer.renderCyclicNote(cyclicNoteView({
    tasks: [
      cyclicTask(3, null, { desc: "无任务 ID" }),
      cyclicTask(1, "1001"),
      cyclicTask(2, 1004),
      cyclicTask(4, 1005),
    ],
  }));

  assert.deepEqual(findAllByAttribute(host, "data-cyclic-note-task-key"), [fallback3, task1, findByAttribute(host, "data-cyclic-note-task-key", "1004:2")]);
  assert.strictEqual(findByAttribute(host, "data-cyclic-note-task-key", "slot:3"), fallback3);
  assert.strictEqual(findByAttribute(host, "data-cyclic-note-task-key", "1001:1"), task1);
  assert.equal(task2.parentNode, null);
  assert.equal(findAllByAttribute(host, "data-cyclic-note-task-key").length, 3);
});

test("cyclic-note duplicate taskIds remain distinct by slot and fallback identity is stable", () => {
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderCyclicNote(cyclicNoteView({
    tasks: [cyclicTask(1, 1001), cyclicTask(2, 1001), cyclicTask(3, null)],
  }));
  const host = findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-task-list", "true");
  const first = findByAttribute(host, "data-cyclic-note-task-key", "1001:1");
  const second = findByAttribute(host, "data-cyclic-note-task-key", "1001:2");
  const fallback = findByAttribute(host, "data-cyclic-note-task-key", "slot:3");
  assert.ok(first && second && fallback);
  assert.notStrictEqual(first, second);
  fixture.clearWrites();

  renderer.renderCyclicNote(cyclicNoteView({
    tasks: [cyclicTask(1, "1001"), cyclicTask(2, 1001), cyclicTask(3, undefined)],
  }));

  assert.strictEqual(findByAttribute(host, "data-cyclic-note-task-key", "1001:1"), first);
  assert.strictEqual(findByAttribute(host, "data-cyclic-note-task-key", "1001:2"), second);
  assert.strictEqual(findByAttribute(host, "data-cyclic-note-task-key", "slot:3"), fallback);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("ordinary and cyclic-note dynamic strings stay inside textContent leaves", () => {
  const unsafe = "<img src=x onerror=alert(1)>";
  const fixture = createFixture();
  const renderer = createQueueCollectionsRenderer(fixture.getNode);
  renderer.renderOrdinary(ordinaryView([orderSlot(1, {
    statusText: unsafe,
    requirements: [flower(23001, unsafe, unsafe)],
  })]));
  renderer.renderCyclicNote(cyclicNoteView({
    status: unsafe,
    rule: unsafe,
    tasks: [cyclicTask(1, 1001, {
      qualityText: unsafe,
      desc: unsafe,
      progressText: unsafe,
      rewardText: unsafe,
      statusText: unsafe,
    })],
  }));

  const item = findByAttribute(fixture.nodes.ordinaryResidentSlotsHost, "data-ordinary-resident-item-key", "23001:1");
  assert.equal(findByAttribute(item, "data-ordinary-resident-item-field", "name").textContent, unsafe);
  assert.equal(findByAttribute(item, "data-ordinary-resident-item-field", "need").textContent, unsafe);
  const task = findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-task-key", "1001:1");
  for (const field of ["quality", "description", "progress", "reward", "status"]) {
    assert.equal(findByAttribute(task, "data-cyclic-note-task-field", field).textContent, unsafe, field);
  }
  assert.equal(findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-field", "status").textContent, unsafe);
  assert.equal(findByAttribute(fixture.nodes.cyclicNoteHost, "data-cyclic-note-field", "rule").textContent, unsafe);
});

function ordinaryView(slots = []) {
  return { slots };
}

function orderSlot(boxId, overrides = {}) {
  return {
    boxId,
    mode: "order",
    state: "ready",
    statusText: "可完成",
    remainingSeconds: "0",
    requirements: [flower(23001, "白百合", "5")],
    ...overrides,
  };
}

function refillSlot(boxId, overrides = {}) {
  return {
    boxId,
    mode: "refill",
    state: "refill",
    statusText: "等待补位",
    remainingSeconds: "12",
    serviceWaiting: false,
    requirements: [],
    ...overrides,
  };
}

function videoSlot(boxId, overrides = {}) {
  return {
    boxId,
    mode: "video",
    state: "video",
    statusText: "视频订单",
    remainingSeconds: "0",
    requirements: [],
    ...overrides,
  };
}

function flower(itemId, name, need) {
  return { itemId, name, need };
}

function cyclicNoteView(overrides = {}) {
  return {
    state: "idle",
    pending: "0",
    phase: "活动进行中",
    phaseRemaining: "0天00时01分00秒",
    taskCount: "0",
    score: "21/80",
    status: "暂无可领取任务",
    rule: "达标后自动领取",
    autoHandleEnabled: true,
    autoHandleDisabled: false,
    autoCompleteEnabled: true,
    autoCompleteDisabled: false,
    tasks: [],
    ...overrides,
  };
}

function cyclicTask(slotIndex, taskId, overrides = {}) {
  return {
    slotIndex,
    taskId,
    qualityText: "1星",
    desc: `任务 ${slotIndex}`,
    progressText: "1/3",
    rewardText: "集芳笺x2",
    statusText: "进行中",
    ...overrides,
  };
}

function createFixture() {
  const document = new FakeDocument();
  const nodes = {
    ordinaryResidentSlotsHost: document.createElement("div"),
    cyclicNoteHost: document.createElement("div"),
  };
  nodes.ordinaryResidentSlotsHost.id = "ordinaryResidentSlotsHost";
  nodes.cyclicNoteHost.id = "cyclicNoteHost";
  document.body.append(nodes.ordinaryResidentSlotsHost, nodes.cyclicNoteHost);
  document.writes.length = 0;
  document.structuralWrites.length = 0;
  return {
    document,
    nodes,
    writes: document.writes,
    structuralWrites: document.structuralWrites,
    getNode(id) {
      return nodes[id];
    },
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
    this.body = new FakeElement("body", this);
  }

  createElement(tagName) {
    return new FakeElement(tagName, this);
  }
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = String(tagName).toUpperCase();
    this.ownerDocument = ownerDocument;
    this.id = "";
    this.parentNode = null;
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this._textContent = "";
    this._hidden = false;
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

  get textContent() {
    return this._textContent;
  }

  set textContent(value) {
    if (this.children.length) {
      for (const child of this.children) child.parentNode = null;
      this.children.length = 0;
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
    throw new Error("T5 queue collections must not use innerHTML");
  }

  set outerHTML(_value) {
    throw new Error("T5 queue collections must not use outerHTML");
  }

  replaceChildren() {
    throw new Error("T5 queue collections must not use replaceChildren");
  }

  insertAdjacentHTML() {
    throw new Error("T5 queue collections must not use insertAdjacentHTML");
  }

  append(...nodes) {
    for (const node of nodes) this.insertBefore(node, null);
  }

  insertBefore(node, referenceNode) {
    if (node.parentNode) node.parentNode.removeChild(node, { moving: true });
    const index = referenceNode == null ? this.children.length : this.children.indexOf(referenceNode);
    assert.ok(index >= 0, "reference node must be a child");
    this.children.splice(index, 0, node);
    node.parentNode = this;
    this.ownerDocument.structuralWrites.push({ kind: "insert", parent: this, node, referenceNode });
    return node;
  }

  removeChild(node, options = {}) {
    const index = this.children.indexOf(node);
    assert.ok(index >= 0, "removed node must be a child");
    this.children.splice(index, 1);
    node.parentNode = null;
    if (!options.moving) this.ownerDocument.structuralWrites.push({ kind: "remove", parent: this, node });
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
    this.ownerDocument.writes.push({ node: this, kind: "attribute-set", name, value: normalized });
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    this.ownerDocument.writes.push({ node: this, kind: "attribute-remove", name });
  }
}

function findByAttribute(root, name, value) {
  if (!root) return null;
  if (root.getAttribute(name) === String(value)) return root;
  for (const child of root.children) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

function findAllByAttribute(root, name, value = undefined) {
  if (!root) return [];
  const matches = [];
  const attribute = root.getAttribute(name);
  if (attribute !== null && (value === undefined || attribute === String(value))) matches.push(root);
  for (const child of root.children) matches.push(...findAllByAttribute(child, name, value));
  return matches;
}

function propertyWrite(node, value, name = "textContent") {
  return { node, kind: "property", name, value };
}
