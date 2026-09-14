import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const archiveModule = await import("./system/public/team-order-archive-view.js").catch(() => ({}));
const { createTeamOrderArchiveRenderer } = archiveModule;

test("T5 exposes a keyed team-order archive renderer without innerHTML rebuilds", async () => {
  assert.equal(typeof createTeamOrderArchiveRenderer, "function");
  const [app, view] = await Promise.all([
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/team-order-archive-view.js", "utf8").catch(() => ""),
  ]);

  assert.doesNotMatch(functionSlice(app, "renderTeamOrders", "emptyTeamOrderPage"), /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);
});

test("loading error and empty states keep fixed container identity", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);

  renderer.render(teamOrderView({ loading: true }));
  const loading = findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-state", "loading");
  const error = findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-state", "error");
  const empty = findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-state", "empty");
  const groups = findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-groups", "");
  assert.ok(loading);
  assert.ok(error);
  assert.ok(empty);
  assert.ok(groups);
  assert.equal(loading.hidden, false);
  assert.equal(error.hidden, true);
  assert.equal(empty.hidden, true);

  renderer.render(teamOrderView({ error: "接口 <失败>" }));
  assert.strictEqual(findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-state", "loading"), loading);
  assert.strictEqual(findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-state", "error"), error);
  assert.strictEqual(findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-state", "empty"), empty);
  assert.strictEqual(findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-groups", ""), groups);
  assert.equal(loading.hidden, true);
  assert.equal(error.hidden, false);
  assert.equal(findByAttribute(error, "data-team-order-field", "error-message").textContent, "接口 <失败>");

  renderer.render(teamOrderView());
  assert.equal(error.hidden, true);
  assert.equal(empty.hidden, false);
  assert.equal(groups.hidden, true);
  assert.equal(findByAttribute(fixture.nodes.teamOrderPageText, "data-team-order-field", "visible-day-count").textContent, "7");
  assert.equal(findByAttribute(fixture.nodes.teamOrderPageText, "data-team-order-field", "visible-count").textContent, "0");
});

test("date groups use local date labels as stable keys", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const view = teamOrderView({
    groups: [
      dayGroup("2026/08/04", [archiveItem("run-a")]),
      dayGroup("2026/08/03", [archiveItem("run-b")]),
    ],
    visibleCount: "2",
  });

  renderer.render(view);
  const groupHost = findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-groups", "");
  const firstRefs = [...groupHost.children];
  assert.deepEqual(firstRefs.map((node) => node.getAttribute("data-team-order-date-key")), [
    "2026/08/04",
    "2026/08/03",
  ]);
  fixture.clearWrites();

  renderer.render(structuredClone(view));

  assert.deepEqual(groupHost.children, firstRefs);
  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("archive items use runId and the finishedAt plus htmlName fallback as stable keys", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const noRunIdA = archiveItem(null, {
    finishedAt: "2026-08-04T01:01:00.000Z",
    htmlName: "team-order-20260804T010100000Z-aaaaaaaaaaaaaaaaaaaaaaaa.html",
  });
  const noRunIdB = archiveItem(null, {
    finishedAt: "2026-08-04T01:01:00.000Z",
    htmlName: "team-order-20260804T010100000Z-bbbbbbbbbbbbbbbbbbbbbbbb.html",
  });
  renderer.render(teamOrderView({ groups: [dayGroup("2026/08/04", [archiveItem("run-a"), noRunIdA, noRunIdB])] }));
  const group = getDayGroup(fixture, "2026/08/04");
  const [runIdNode, fallbackA, fallbackB] = getArchiveItems(group);
  assert.notStrictEqual(fallbackA, fallbackB);
  fixture.clearWrites();

  renderer.render(teamOrderView({
    groups: [dayGroup("2026/08/04", [
      { ...noRunIdB, gold: "9万" },
      archiveItem("run-a"),
      { ...noRunIdA, submitted: "8" },
    ])],
  }));

  const [nextFallbackB, nextRunId, nextFallbackA] = getArchiveItems(group);
  assert.strictEqual(nextFallbackB, fallbackB);
  assert.strictEqual(nextRunId, runIdNode);
  assert.strictEqual(nextFallbackA, fallbackA);
});

test("date groups and archive items add delete and reorder while reusing survivors", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  renderer.render(teamOrderView({
    groups: [
      dayGroup("2026/08/04", [archiveItem("a"), archiveItem("b")]),
      dayGroup("2026/08/03", [archiveItem("c")]),
    ],
  }));
  const groupsHost = getGroupsHost(fixture);
  const august4 = getDayGroup(fixture, "2026/08/04");
  const august3 = getDayGroup(fixture, "2026/08/03");
  const [a, b] = getArchiveItems(august4);
  const [c] = getArchiveItems(august3);
  fixture.nodes.teamOrderArchiveList.scrollTop = 86;
  fixture.clearWrites();

  renderer.render(teamOrderView({
    groups: [
      dayGroup("2026/08/03", [archiveItem("c")]),
      dayGroup("2026/08/04", [archiveItem("b"), archiveItem("d")]),
    ],
  }));

  assert.deepEqual(groupsHost.children, [august3, august4]);
  assert.strictEqual(getArchiveItems(august3)[0], c);
  assert.strictEqual(getArchiveItems(august4)[0], b);
  assert.notStrictEqual(getArchiveItems(august4)[1], a);
  assert.equal(a.parentNode, null);
  assert.equal(fixture.nodes.teamOrderArchiveList.scrollTop, 86);
  assert.deepEqual(fixture.writes.filter((write) => isWithin(write.node, b) || isWithin(write.node, c)), []);
});

test("an archive item keeps identity when the same runId moves across date groups", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const moving = archiveItem("moving-run");
  renderer.render(teamOrderView({
    groups: [
      dayGroup("2026/08/04", [moving, archiveItem("day-four")]),
      dayGroup("2026/08/03", [archiveItem("day-three")]),
    ],
  }));
  const movingCard = getArchiveItems(getDayGroup(fixture, "2026/08/04"))[0];

  renderer.render(teamOrderView({
    groups: [
      dayGroup("2026/08/04", [archiveItem("day-four")]),
      dayGroup("2026/08/03", [
        { ...moving, finishedAt: "2026-08-03T23:59:00.000Z", timeText: "23:59:00" },
        archiveItem("day-three"),
      ]),
    ],
  }));

  assert.strictEqual(getArchiveItems(getDayGroup(fixture, "2026/08/03"))[0], movingCard);
  assert.equal(findByAttribute(movingCard, "data-team-order-field", "finished-time").textContent, "23:59:00");
});

test("changing the visible archive count writes only its count leaf", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  renderer.render(teamOrderView());
  const count = findByAttribute(fixture.nodes.teamOrderPageText, "data-team-order-field", "visible-count");
  fixture.clearWrites();

  renderer.render(teamOrderView({ visibleCount: "1" }));

  assert.deepEqual(fixture.writes, [
    { node: count, kind: "property", name: "textContent", value: "1" },
  ]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("changing one archive metric writes only its dynamic value leaf", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const item = archiveItem("run-a");
  renderer.render(teamOrderView({ groups: [dayGroup("2026/08/04", [item])] }));
  const card = getArchiveItems(getDayGroup(fixture, "2026/08/04"))[0];
  const submitted = findByAttribute(card, "data-team-order-field", "submitted");
  fixture.clearWrites();

  renderer.render(teamOrderView({
    groups: [dayGroup("2026/08/04", [{ ...item, submitted: "9" }])],
  }));

  assert.deepEqual(fixture.writes, [
    { node: submitted, kind: "property", name: "textContent", value: "9" },
  ]);
  assert.deepEqual(fixture.structuralWrites, []);
  assert.strictEqual(getArchiveItems(getDayGroup(fixture, "2026/08/04"))[0], card);
});

test("archive links are encoded and unavailable links keep a fixed disabled text node", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const safeName = "team-order-20260804T010203000Z-aaaaaaaaaaaaaaaaaaaaaaaa.html";
  renderer.render(teamOrderView({
    profileId: "<p/ 1>",
    groups: [dayGroup("2026/08/04", [
      archiveItem("safe", { htmlName: safeName }),
      archiveItem("missing", { htmlName: null }),
    ])],
  }));
  const [safeCard, missingCard] = getArchiveItems(getDayGroup(fixture, "2026/08/04"));
  const safeLink = findByAttribute(safeCard, "data-team-order-field", "detail");
  const disabledLink = findByAttribute(missingCard, "data-team-order-field", "detail");

  assert.equal(safeLink.tagName, "A");
  assert.equal(safeLink.textContent, "详情");
  assert.equal(safeLink.getAttribute("href"), `/artifacts/%3Cp%2F%201%3E/team-orders/${safeName}`);
  assert.equal(safeLink.getAttribute("target"), "_blank");
  assert.equal(safeLink.getAttribute("rel"), "noreferrer");
  assert.equal(disabledLink.tagName, "SPAN");
  assert.equal(disabledLink.textContent, "详情不可用");
  assert.equal(disabledLink.getAttribute("href"), null);
});

test("untrusted archive values are rendered as text and never parsed as markup", () => {
  const fixture = createFixture();
  const renderer = createRenderer(fixture);
  const unsafe = "<img src=x onerror=alert(1)>";
  renderer.render(teamOrderView({
    groups: [dayGroup("2026/08/04", [archiveItem("unsafe", {
      timeText: unsafe,
      renewalText: unsafe,
      submitted: unsafe,
      experience: unsafe,
    })])],
  }));
  const card = getArchiveItems(getDayGroup(fixture, "2026/08/04"))[0];

  assert.equal(findByAttribute(card, "data-team-order-field", "finished-time").textContent, unsafe);
  assert.equal(findByAttribute(card, "data-team-order-field", "renewal").textContent, unsafe);
  assert.equal(findByAttribute(card, "data-team-order-field", "submitted").textContent, unsafe);
  assert.equal(findByAttribute(card, "data-team-order-field", "experience").textContent, unsafe);
  assert.equal(findAllByTagName(card, "IMG").length, 0);
});

function createRenderer(fixture) {
  assert.equal(typeof createTeamOrderArchiveRenderer, "function");
  return createTeamOrderArchiveRenderer(fixture.getNode);
}

function teamOrderView(overrides = {}) {
  return {
    loading: false,
    error: "",
    groups: [],
    dayCount: "7",
    visibleCount: "0",
    profileId: "p1",
    ...overrides,
  };
}

function dayGroup(dateLabel, items) {
  return {
    dateLabel,
    count: String(items.length),
    items,
  };
}

function archiveItem(runId, overrides = {}) {
  return {
    runId,
    finishedAt: "2026-08-04T01:02:03.000Z",
    timeText: "09:02:03",
    paidRenew: false,
    renewalText: "普通轮",
    htmlName: "team-order-20260804T010203000Z-aaaaaaaaaaaaaaaaaaaaaaaa.html",
    submitted: "1",
    refreshed: "2",
    skipped: "3",
    experience: "4万",
    gold: "5万",
    ...overrides,
  };
}

function createFixture() {
  const document = new FakeDocument();
  const nodes = {
    teamOrderPageText: document.createElement("span"),
    teamOrderArchiveList: document.createElement("div"),
  };
  for (const [id, node] of Object.entries(nodes)) {
    node.id = id;
    document.body.append(node);
  }
  document.writes.length = 0;
  document.structuralWrites.length = 0;
  return {
    document,
    nodes,
    writes: document.writes,
    structuralWrites: document.structuralWrites,
    getNode: (id) => nodes[id],
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
    this.scrollTop = 0;
    this._textContent = "";
    this._hidden = false;
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => {
        for (const name of names) this.classes.add(name);
      },
      remove: (...names) => {
        for (const name of names) this.classes.delete(name);
      },
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

  get className() {
    return [...this.classes].join(" ");
  }

  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
    this.ownerDocument.writes.push({ node: this, kind: "property", name: "className", value: String(value) });
  }

  set innerHTML(_value) {
    throw new Error("T5 team-order archive nodes must not use innerHTML");
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

function getGroupsHost(fixture) {
  return findByAttribute(fixture.nodes.teamOrderArchiveList, "data-team-order-groups", "");
}

function getDayGroup(fixture, dateKey) {
  return findByAttribute(getGroupsHost(fixture), "data-team-order-date-key", dateKey);
}

function getArchiveItems(group) {
  const grid = findByAttribute(group, "data-team-order-items", "");
  return [...grid.children];
}

function findByAttribute(root, name, value) {
  if (root?.getAttribute(name) === value) return root;
  for (const child of root?.children || []) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

function findAllByTagName(root, tagName) {
  const normalized = String(tagName).toUpperCase();
  const matches = [];
  if (root?.tagName === normalized) matches.push(root);
  for (const child of root?.children || []) matches.push(...findAllByTagName(child, normalized));
  return matches;
}

function isWithin(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode;
  }
  return false;
}

function functionSlice(script, startName, endName) {
  const start = script.indexOf(`function ${startName}`);
  const end = script.indexOf(`function ${endName}`);
  assert.ok(start >= 0, `${startName} must exist`);
  assert.ok(end > start, `${endName} must follow ${startName}`);
  return script.slice(start, end);
}
