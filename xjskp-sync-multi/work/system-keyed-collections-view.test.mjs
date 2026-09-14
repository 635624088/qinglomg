import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const viewModule = await import("./system/public/keyed-collections-view.js").catch(() => ({}));
const { createKeyedCollectionsRenderer } = viewModule;
const publicDir = path.join(import.meta.dirname, "system", "public");

test("T3 exposes fixed profile hosts and removes collection innerHTML rebuilds", async () => {
  assert.equal(typeof createKeyedCollectionsRenderer, "function");
  const [html, app, view] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "keyed-collections-view.js"), "utf8"),
  ]);

  for (const id of ["legacyList", "profiles", "profilesEmpty", "profileItems", "wizardMissingItems"]) {
    assert.equal((html.match(new RegExp(`id=["']${id}["']`, "g")) || []).length, 1, id);
  }
  for (const [start, end] of [
    ["renderLegacyBanner", "renderProfiles"],
    ["renderProfiles", "renderWizard"],
    ["renderWizard", "renderTask"],
  ]) {
    assert.doesNotMatch(functionSlice(app, start, end), /\.innerHTML\s*=/);
  }
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|replaceChildren/);
});

test("same collection snapshots keep item identity and perform zero writes", () => {
  const fixture = createFixture();
  const selected = [];
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, {
    onProfileSelect: (profileId) => selected.push(profileId),
  });
  const profiles = [profileView("p1"), profileView("p2", { selected: true })];
  const legacy = [legacyView(101), legacyView(202)];
  const missing = ["CTOKEN", "OPEN_ID"];

  renderer.renderLegacy(legacy.map((item) => ({ ...item })));
  renderer.renderProfiles({ empty: false, items: profiles.map((item) => ({ ...item })) });
  renderer.renderMissingFields([...missing]);
  const legacyRefs = [...fixture.nodes.legacyList.children];
  const profileRefs = [...fixture.nodes.profileItems.children];
  const missingRefs = [...fixture.nodes.wizardMissingItems.children];
  fixture.clearWrites();

  renderer.renderLegacy(legacy);
  renderer.renderProfiles({ empty: false, items: profiles });
  renderer.renderMissingFields(missing);

  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);
  assert.deepEqual(fixture.nodes.legacyList.children, legacyRefs);
  assert.deepEqual(fixture.nodes.profileItems.children, profileRefs);
  assert.deepEqual(fixture.nodes.wizardMissingItems.children, missingRefs);
  assert.equal(profileRefs[0].listenerCount("click"), 1);
  profileRefs[0].click();
  assert.deepEqual(selected, ["p1"]);
});

test("changing one profile label only writes that label node", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  renderer.renderProfiles({ empty: false, items: [profileView("p1")] });
  const card = fixture.nodes.profileItems.children[0];
  const title = card.children[0].children[0];
  fixture.clearWrites();

  renderer.renderProfiles({
    empty: false,
    items: [profileView("p1", { label: "修改后的账号名" })],
  });

  assert.deepEqual(fixture.writes, [{ node: title, kind: "property", name: "textContent", value: "修改后的账号名" }]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("running profile pid mode and start time are independent dynamic leaves", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  const running = profileView("p1", {
    runState: "running",
    runLabel: "运行中",
    runPid: "1001",
    runMode: "循环",
    runStartedAt: "08-04 12:00",
  });
  renderer.renderProfiles({ empty: false, items: [running] });
  const card = fixture.nodes.profileItems.children[0];
  const pidNode = findByAttribute(card, "data-profile-field", "run-pid");
  const modeNode = findByAttribute(card, "data-profile-field", "run-mode");
  const startedNode = findByAttribute(card, "data-profile-field", "run-started-at");
  fixture.clearWrites();

  renderer.renderProfiles({
    empty: false,
    items: [{ ...running, runPid: "1002" }],
  });

  assert.deepEqual(fixture.writes, [{ node: pidNode, kind: "property", name: "textContent", value: "1002" }]);
  assert.equal(modeNode.textContent, "循环");
  assert.equal(startedNode.textContent, "08-04 12:00");
  assert.deepEqual(fixture.structuralWrites, []);
});

test("profile descriptions stay text-only and changing an error only writes its leaf", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  const unsafe = "<img src=x onerror=1>";
  const errorProfile = profileView("p1", {
    label: unsafe,
    missingTitle: `缺少 ${unsafe}`,
    runState: "error",
    runLabel: "异常退出",
    runError: unsafe,
  });
  renderer.renderProfiles({ empty: false, items: [errorProfile] });
  const card = fixture.nodes.profileItems.children[0];
  const labelNode = findByAttribute(card, "data-profile-field", "label");
  const errorNode = findByAttribute(card, "data-profile-field", "run-error");
  assert.equal(card.getAttribute("title"), `缺少 ${unsafe}`);
  assert.equal(labelNode.textContent, unsafe);
  assert.equal(errorNode.textContent, unsafe);
  fixture.clearWrites();

  renderer.renderProfiles({
    empty: false,
    items: [{ ...errorProfile, runError: "新的异常原因" }],
  });

  assert.deepEqual(fixture.writes, [
    { node: errorNode, kind: "property", name: "textContent", value: "新的异常原因" },
  ]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("changing the selected profile only toggles the two active classes", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  renderer.renderProfiles({
    empty: false,
    items: [profileView("p1", { selected: true }), profileView("p2")],
  });
  const [p1, p2] = fixture.nodes.profileItems.children;
  fixture.clearWrites();

  renderer.renderProfiles({
    empty: false,
    items: [profileView("p1"), profileView("p2", { selected: true })],
  });

  assert.deepEqual(fixture.writes, [
    { node: p1, kind: "class-toggle", name: "active", value: false },
    { node: p2, kind: "class-toggle", name: "active", value: true },
  ]);
  assert.deepEqual(fixture.structuralWrites, []);
  assert.deepEqual(fixture.nodes.profileItems.children, [p1, p2]);
  assert.equal(p1.listenerCount("click"), 1);
  assert.equal(p2.listenerCount("click"), 1);
});

test("profile reconciliation adds deletes and reorders without rebuilding survivors", () => {
  const fixture = createFixture();
  const selected = [];
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, {
    onProfileSelect: (profileId) => selected.push(profileId),
  });
  renderer.renderProfiles({
    empty: false,
    items: [profileView("p1"), profileView("p2"), profileView("p3")],
  });
  const [p1, p2, p3] = fixture.nodes.profileItems.children;
  fixture.nodes.profiles.scrollTop = 73;
  fixture.clearWrites();

  renderer.renderProfiles({
    empty: false,
    items: [profileView("p3"), profileView("p1"), profileView("p4")],
  });

  const [nextP3, nextP1, p4] = fixture.nodes.profileItems.children;
  assert.strictEqual(nextP3, p3);
  assert.strictEqual(nextP1, p1);
  assert.notStrictEqual(p4, p2);
  assert.equal(p2.parentNode, null);
  assert.equal(fixture.nodes.profiles.scrollTop, 73);
  assert.deepEqual(fixture.writes.filter((write) => isWithin(write.node, p1) || isWithin(write.node, p3)), []);
  assert.equal(nextP3.listenerCount("click"), 1);
  nextP3.click();
  assert.deepEqual(selected, ["p3"]);
});

test("legacy processes reconcile by pid and render untrusted strings as text", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  renderer.renderLegacy([
    legacyView(101, { name: "<img src=x onerror=1>", commandLine: "<script>bad()</script>" }),
    legacyView(202),
  ]);
  const [p101, p202] = fixture.nodes.legacyList.children;
  assert.equal(p101.children[1].textContent, "<img src=x onerror=1>");
  assert.equal(p101.children[2].textContent, "<script>bad()</script>");
  fixture.clearWrites();

  renderer.renderLegacy([legacyView(202), legacyView(303)]);

  const [nextP202, p303] = fixture.nodes.legacyList.children;
  assert.strictEqual(nextP202, p202);
  assert.notStrictEqual(p303, p101);
  assert.equal(p101.parentNode, null);
  assert.deepEqual(fixture.writes.filter((write) => isWithin(write.node, p202)), []);
});

test("changing one legacy command line only writes its code leaf", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  renderer.renderLegacy([legacyView(101)]);
  const processNode = fixture.nodes.legacyList.children[0];
  const commandLine = processNode.children[2];
  fixture.clearWrites();

  renderer.renderLegacy([legacyView(101, { commandLine: "node changed.mjs" })]);

  assert.deepEqual(fixture.writes, [
    { node: commandLine, kind: "property", name: "textContent", value: "node changed.mjs" },
  ]);
  assert.deepEqual(fixture.structuralWrites, []);
});

test("legacy reorder normalizes pid keys and performs the minimum necessary move", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  renderer.renderLegacy([legacyView(101), legacyView(202), legacyView(303)]);
  const [p101, p202, p303] = fixture.nodes.legacyList.children;
  fixture.clearWrites();

  renderer.renderLegacy([legacyView("202"), legacyView("303"), legacyView("101")]);

  assert.deepEqual(fixture.nodes.legacyList.children, [p202, p303, p101]);
  assert.deepEqual(fixture.writes, []);
  assert.equal(fixture.structuralWrites.length, 1);
  assert.deepEqual(fixture.structuralWrites[0], {
    kind: "insert",
    parent: fixture.nodes.legacyList,
    node: p101,
    referenceNode: null,
  });
});

test("missing fields reconcile by field name and the fixed empty profile node survives", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  const emptyNode = fixture.nodes.profilesEmpty;
  renderer.renderMissingFields(["CTOKEN", "<svg onload=1>", "OPEN_ID"]);
  renderer.renderProfiles({ empty: true, items: [] });
  const [ctoken, unsafe, openId] = fixture.nodes.wizardMissingItems.children;
  assert.equal(unsafe.textContent, "<svg onload=1>");
  assert.equal(emptyNode.hidden, false);
  fixture.clearWrites();

  renderer.renderMissingFields(["OPEN_ID", "CTOKEN", "PC_TOKEN"]);
  renderer.renderProfiles({ empty: false, items: [profileView("p1")] });

  const [nextOpenId, nextCtoken] = fixture.nodes.wizardMissingItems.children;
  assert.strictEqual(nextOpenId, openId);
  assert.strictEqual(nextCtoken, ctoken);
  assert.equal(unsafe.parentNode, null);
  assert.strictEqual(fixture.nodes.profilesEmpty, emptyNode);
  assert.equal(emptyNode.hidden, true);
});

test("non-empty collections clear once and repeated empty snapshots perform zero writes", () => {
  const fixture = createFixture();
  const renderer = createKeyedCollectionsRenderer(fixture.getNode, { onProfileSelect() {} });
  const emptyNode = fixture.nodes.profilesEmpty;
  renderer.renderLegacy([legacyView(101)]);
  renderer.renderMissingFields(["CTOKEN"]);
  renderer.renderProfiles({ empty: false, items: [profileView("p1")] });
  fixture.clearWrites();

  renderer.renderLegacy([]);
  renderer.renderMissingFields([]);
  renderer.renderProfiles({ empty: true, items: [] });

  assert.equal(fixture.nodes.legacyList.children.length, 0);
  assert.equal(fixture.nodes.wizardMissingItems.children.length, 0);
  assert.equal(fixture.nodes.profileItems.children.length, 0);
  assert.strictEqual(fixture.nodes.profilesEmpty, emptyNode);
  assert.equal(emptyNode.hidden, false);
  assert.equal(fixture.structuralWrites.filter((write) => write.kind === "remove").length, 3);
  fixture.clearWrites();

  renderer.renderLegacy([]);
  renderer.renderMissingFields([]);
  renderer.renderProfiles({ empty: true, items: [] });

  assert.deepEqual(fixture.writes, []);
  assert.deepEqual(fixture.structuralWrites, []);
});

function profileView(id, overrides = {}) {
  return {
    id,
    label: `账号 ${id}`,
    missingTitle: "凭据完整",
    hasCredentials: true,
    hasMissingFields: false,
    missingCount: "0",
    hasValidation: false,
    validationTime: "",
    selected: false,
    runState: "stopped",
    runLabel: "未运行",
    runPid: "-",
    runMode: "-",
    runStartedAt: "-",
    runHasMissingFields: false,
    runMissingCount: "0",
    runError: "",
    ...overrides,
  };
}

function legacyView(pid, overrides = {}) {
  return { pid, name: `进程 ${pid}`, commandLine: `node worker-${pid}.mjs`, ...overrides };
}

function createFixture() {
  const document = new FakeDocument();
  const writes = [];
  const structuralWrites = [];
  document.writes = writes;
  document.structuralWrites = structuralWrites;
  const nodes = {};
  for (const id of ["legacyList", "profiles", "profilesEmpty", "profileItems", "wizardMissingItems"]) {
    nodes[id] = document.createElement("div");
    nodes[id].id = id;
  }
  nodes.profilesEmpty.classList.add("empty-state");
  nodes.profiles.append(nodes.profilesEmpty, nodes.profileItems);
  writes.length = 0;
  structuralWrites.length = 0;
  const getNode = (id) => nodes[id];
  return {
    document,
    nodes,
    writes,
    structuralWrites,
    getNode,
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

  set innerHTML(_value) {
    throw new Error("T3 collection nodes must not use innerHTML");
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

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  listenerCount(type) {
    return (this.listeners.get(type) || []).length;
  }

  click() {
    for (const handler of this.listeners.get("click") || []) handler({ target: this });
  }
}

function isWithin(node, ancestor) {
  let current = node;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode;
  }
  return false;
}

function findByAttribute(root, name, value) {
  if (root.getAttribute(name) === value) return root;
  for (const child of root.children) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

function functionSlice(script, startName, endName) {
  const start = script.indexOf(`function ${startName}`);
  const end = script.indexOf(`function ${endName}`);
  assert.ok(start >= 0, `${startName} must exist`);
  assert.ok(end > start, `${endName} must follow ${startName}`);
  return script.slice(start, end);
}
