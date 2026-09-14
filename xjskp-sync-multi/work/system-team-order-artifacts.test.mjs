import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const artifactModule = await import("./system/team-order-artifacts.mjs").catch(() => ({}));
const { isSafeTeamOrderHtmlName, listTeamOrderArtifacts } = artifactModule;

test("listTeamOrderArtifacts returns newest files with bounded pagination", async (t) => {
  assert.equal(typeof listTeamOrderArtifacts, "function");
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-page-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runIds = [
    "111111111111111111111111",
    "222222222222222222222222",
    "333333333333333333333333",
    "444444444444444444444444",
    "555555555555555555555555",
  ];
  for (let index = 1; index <= 5; index += 1) {
    const runId = runIds[index - 1];
    await writeFile(path.join(dir, `${runId}.json`), JSON.stringify({
      runId,
      profileId: "p1",
      startedAt: `2026-07-2${index}T00:00:00.000Z`,
      finishedAt: index === 5 ? null : `2026-07-2${index}T00:01:00.000Z`,
      finalStatus: index === 5 ? "running" : "completed",
      serverOrderNum: index + 10,
      completedOrderCount: index + 9,
      paidRenewAvailable: index === 4,
      paidRenewSkipped: index === 4,
      htmlFile: `team-order-2026072${index}T000000000Z-${runId}.html`,
    }), "utf8");
  }

  const page = await listTeamOrderArtifacts(dir, { page: 2, pageSize: 2 });

  assert.deepEqual(page.items.map((item) => item.runId), [
    "333333333333333333333333",
    "222222222222222222222222",
  ]);
  assert.equal(page.page, 2);
  assert.equal(page.pageSize, 2);
  assert.equal(page.total, 5);
  assert.equal(page.items[0].serverOrderNum, 13);
  assert.equal(page.items[0].completedOrderCount, 12);
  assert.equal(page.summary.recent.paidRenewAvailable, true);
  assert.equal(page.summary.recent.paidRenewSkipped, true);
  assert.deepEqual({
    current: page.summary?.current?.runId,
    recent: page.summary?.recent?.runId,
  }, {
    current: undefined,
    recent: "444444444444444444444444",
  });

  const bounded = await listTeamOrderArtifacts(dir, { page: -100, pageSize: 500 });
  assert.equal(bounded.page, 1);
  assert.equal(bounded.pageSize, 50);

  const defaults = await listTeamOrderArtifacts(dir, { page: null, pageSize: null });
  assert.equal(defaults.page, 1);
  assert.equal(defaults.pageSize, 20);
});

test("listTeamOrderArtifacts keeps a damaged ledger as a readError item", async (t) => {
  assert.equal(typeof listTeamOrderArtifacts, "function");
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-damaged-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "666666666666666666666666.json"), "{not-json", "utf8");

  const page = await listTeamOrderArtifacts(dir, { page: 1, pageSize: 20 });

  assert.equal(page.total, 1);
  assert.equal(page.items[0].runId, "666666666666666666666666");
  assert.equal(page.items[0].readError, true);
  assert.equal(page.items[0].htmlName, null);
});

test("listTeamOrderArtifacts keeps an unknown server order number unknown", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-unknown-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runId = "777777777777777777777777";
  await writeFile(path.join(dir, `${runId}.json`), JSON.stringify({
    runId,
    profileId: "p1",
    startedAt: "2026-07-24T00:00:00.000Z",
    finishedAt: "2026-07-24T00:01:00.000Z",
    finalStatus: "completed",
    serverOrderNum: null,
    completedOrderCount: null,
    htmlFile: `team-order-20260724T000000000Z-${runId}.html`,
  }), "utf8");

  const page = await listTeamOrderArtifacts(dir);

  assert.equal(page.items[0].serverOrderNum, null);
  assert.equal(page.items[0].completedOrderCount, null);
});

test("listTeamOrderArtifacts keeps paid-renew rounds separate and defaults legacy ledgers to ordinary", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-paid-renew-split-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [
    {
      runId: "101010101010101010101010",
      startedAt: "2026-08-02T02:00:00.000Z",
      finishedAt: "2026-08-02T02:01:00.000Z",
      paidRenew: false,
      events: [
        { action: "submit", status: "success" },
        { action: "refresh", status: "success" },
      ],
      reward: { calculated: { displayed: { 2: 8_100, 11: 10_200 } } },
    },
    {
      runId: "202020202020202020202020",
      startedAt: "2026-08-02T02:02:00.000Z",
      finishedAt: "2026-08-02T02:03:00.000Z",
      paidRenew: true,
      events: [
        { action: "paid-renew", status: "success" },
        { action: "submit", status: "success" },
        { action: "submit", status: "success" },
      ],
      reward: { calculated: { displayed: { 2: 8_300, 11: 10_400 } } },
    },
    {
      runId: "303030303030303030303030",
      startedAt: "2026-08-02T01:00:00.000Z",
      finishedAt: "2026-08-02T01:01:00.000Z",
      events: [],
      reward: { calculated: { displayed: { 2: 100, 11: 200 } } },
    },
  ];
  for (const record of records) {
    const fileTimestamp = record.startedAt
      .replaceAll("-", "")
      .replaceAll(":", "")
      .replace(".", "");
    await writeFile(path.join(dir, `${record.runId}.json`), JSON.stringify({
      ...record,
      profileId: "p1",
      finalStatus: "completed",
      htmlFile: `team-order-${fileTimestamp}-${record.runId}.html`,
    }), "utf8");
  }

  const page = await listTeamOrderArtifacts(dir);
  const ordinary = page.items.find((item) => item.runId === records[0].runId);
  const renewed = page.items.find((item) => item.runId === records[1].runId);
  const legacy = page.items.find((item) => item.runId === records[2].runId);

  assert.equal(page.total, 3);
  assert.deepEqual({
    submittedCount: ordinary.submittedCount,
    refreshedCount: ordinary.refreshedCount,
    reward: ordinary.reward.calculated.displayed,
    paidRenew: ordinary.paidRenew,
  }, {
    submittedCount: 1,
    refreshedCount: 1,
    reward: { 2: 8_100, 11: 10_200 },
    paidRenew: false,
  });
  assert.deepEqual({
    submittedCount: renewed.submittedCount,
    refreshedCount: renewed.refreshedCount,
    reward: renewed.reward.calculated.displayed,
    paidRenew: renewed.paidRenew,
  }, {
    submittedCount: 2,
    refreshedCount: 0,
    reward: { 2: 8_300, 11: 10_400 },
    paidRenew: true,
  });
  assert.equal(legacy.paidRenew, false);
});

test("listTeamOrderArtifacts does not count an inventory shortage as an error", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-shortage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runId = "888888888888888888888888";
  await writeFile(path.join(dir, `${runId}.json`), JSON.stringify({
    runId,
    profileId: "p1",
    startedAt: "2026-07-24T00:00:00.000Z",
    finishedAt: "2026-07-24T00:01:00.000Z",
    finalStatus: "completed",
    htmlFile: `team-order-20260724T000000000Z-${runId}.html`,
    events: [
      {
        action: "inventory-shortage",
        status: "failure",
        inventoryShortage: true,
      },
      {
        action: "refresh",
        status: "success",
      },
      {
        action: "protected-flower",
        status: "skipped",
      },
    ],
  }), "utf8");

  const page = await listTeamOrderArtifacts(dir);

  assert.equal(page.items[0].refreshedCount, 1);
  assert.equal(page.items[0].skippedCount, 1);
  assert.equal(page.items[0].inventoryShortageCount, 1);
  assert.equal(page.items[0].errorCount, 0);
});

test("listTeamOrderArtifacts sorts completed records by finished time", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-finished-sort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const records = [
    {
      runId: "121212121212121212121212",
      startedAt: "2026-07-30T01:00:00.000Z",
      finishedAt: "2026-07-30T01:02:00.000Z",
    },
    {
      runId: "343434343434343434343434",
      startedAt: "2026-07-30T00:30:00.000Z",
      finishedAt: "2026-07-30T01:03:00.000Z",
    },
  ];
  for (const record of records) {
    const fileTimestamp = record.startedAt
      .replaceAll("-", "")
      .replaceAll(":", "")
      .replace(".", "");
    await writeFile(path.join(dir, `${record.runId}.json`), JSON.stringify({
      ...record,
      profileId: "p1",
      finalStatus: "completed",
      htmlFile: `team-order-${fileTimestamp}-${record.runId}.html`,
    }), "utf8");
  }

  const page = await listTeamOrderArtifacts(dir);

  assert.deepEqual(page.items.map((item) => item.runId), [
    "343434343434343434343434",
    "121212121212121212121212",
  ]);
});

test("listTeamOrderArtifacts never links mismatched JSON ledger and HTML identities", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "aaaaaaaaaaaaaaaaaaaaaaaa.json"), JSON.stringify({
    runId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    profileId: "p1",
    startedAt: "2026-07-24T00:00:00.000Z",
    htmlFile: "team-order-20260724T000000000Z-bbbbbbbbbbbbbbbbbbbbbbbb.html",
  }), "utf8");
  await writeFile(path.join(dir, "cccccccccccccccccccccccc.json"), JSON.stringify({
    runId: "cccccccccccccccccccccccc",
    profileId: "p1",
    startedAt: "2026-07-25T00:00:00.000Z",
    htmlFile: "team-order-20260725T000000000Z-dddddddddddddddddddddddd.html",
  }), "utf8");

  const page = await listTeamOrderArtifacts(dir, { page: 1, pageSize: 20 });

  assert.equal(page.total, 2);
  assert.deepEqual(page.items.map((item) => item.runId), [
    "cccccccccccccccccccccccc",
    "aaaaaaaaaaaaaaaaaaaaaaaa",
  ]);
  assert.equal(page.items.every((item) => item.readError === true), true);
  assert.equal(page.items.every((item) => item.htmlName === null), true);
});

test("listTeamOrderArtifacts rejects an epoch HTML identity when startedAt is missing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "team-order-artifacts-missing-time-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runId = "eeeeeeeeeeeeeeeeeeeeeeee";
  await writeFile(path.join(dir, `${runId}.json`), JSON.stringify({
    runId,
    profileId: "p1",
    startedAt: null,
    htmlFile: `team-order-19700101T000000000Z-${runId}.html`,
  }), "utf8");

  const page = await listTeamOrderArtifacts(dir, { page: 1, pageSize: 20 });

  assert.equal(page.items[0].readError, true);
  assert.equal(page.items[0].htmlName, null);
});

test("isSafeTeamOrderHtmlName accepts only the strict archive HTML shape", () => {
  assert.equal(typeof isSafeTeamOrderHtmlName, "function");
  assert.equal(
    isSafeTeamOrderHtmlName("team-order-20260724T000000000Z-abcdef0123456789abcdef01.html"),
    true,
  );
  for (const name of [
    "../secret.html",
    "team-order-20260724T000000000Z-abcdef0123456789abcdef0.html",
    "team-order-20260724T000000000Z-abcdef0123456789abcdef01.htm",
    "team-order-2026-07-24T000000000Z-abcdef0123456789abcdef01.html",
  ]) {
    assert.equal(isSafeTeamOrderHtmlName(name), false, name);
  }
});

test("system UI keeps the newest selected profile when team-order responses finish out of order", async (t) => {
  const harness = await createUiHarness(t);
  harness.startRace();
  const { document, pending } = harness;
  const [p1Card, p2Card] = document.profileCards;
  p1Card.click();
  p2Card.click();
  await flushTasks();

  assert.equal(pending.has("p1:status"), true);
  assert.equal(pending.has("p1:team-orders"), true);
  assert.equal(pending.has("p2:status"), true);
  assert.equal(pending.has("p2:team-orders"), true);

  pending.get("p2:status").resolve(jsonResponse(profileStatus("p2")));
  pending.get("p2:team-orders").resolve(jsonResponse(teamOrderPage("p2", "new-p2")));
  await flushTasks();
  assert.match(document.getElementById("teamOrderArchiveList").innerHTML, /new-p2/);

  pending.get("p1:status").resolve(jsonResponse(profileStatus("p1")));
  pending.get("p1:team-orders").resolve(jsonResponse(teamOrderPage("p1", "stale-p1")));
  await flushTasks();
  assert.match(document.getElementById("teamOrderArchiveList").innerHTML, /new-p2/);
  assert.doesNotMatch(document.getElementById("teamOrderArchiveList").innerHTML, /stale-p1/);
  assert.match(document.getElementById("selectedProfileLabel").textContent, /P2/);
});

test("system UI clears p1 immediately and still renders p2 orders when p2 status fails", async (t) => {
  const harness = await createUiHarness(t);
  const { document, pending } = harness;
  assert.match(document.getElementById("teamOrderArchiveList").innerHTML, /boot-p1/);
  harness.startRace();

  document.profileCards[1].click();

  assert.doesNotMatch(document.getElementById("teamOrderArchiveList").innerHTML, /boot-p1/);
  pending.get("p2:status").reject(new Error("p2 status unavailable"));
  pending.get("p2:team-orders").resolve(jsonResponse(teamOrderPage("p2", "p2-orders-survive")));
  await flushTasks();
  assert.match(document.getElementById("teamOrderArchiveList").innerHTML, /p2-orders-survive/);
  assert.doesNotMatch(document.getElementById("teamOrderArchiveList").innerHTML, /boot-p1/);
});

test("system UI clears p1 and keeps it cleared when p2 team orders fail", async (t) => {
  const harness = await createUiHarness(t);
  const { document, pending } = harness;
  assert.match(document.getElementById("teamOrderArchiveList").innerHTML, /boot-p1/);
  harness.startRace();

  document.profileCards[1].click();

  assert.doesNotMatch(document.getElementById("teamOrderArchiveList").innerHTML, /boot-p1/);
  pending.get("p2:status").resolve(jsonResponse(profileStatus("p2")));
  pending.get("p2:team-orders").reject(new Error("p2 team orders unavailable"));
  await flushTasks();
  assert.doesNotMatch(document.getElementById("teamOrderArchiveList").innerHTML, /boot-p1/);
  assert.match(document.getElementById("teamOrderArchiveList").innerHTML, /加载失败|暂无/);
  assert.match(document.getElementById("selectedProfileLabel").textContent, /P2/);
});

test("system UI hides unfinished and older records while rendering the recent compact fields", async (t) => {
  const recentTime = new Date(Date.now() - 60_000);
  const oldTime = new Date(recentTime);
  oldTime.setDate(oldTime.getDate() - 7);
  const recent = {
    ...teamOrderItem("p1", "account-recent", recentTime.toISOString()),
    submittedCount: 76,
    refreshedCount: 45,
    skippedCount: 2,
    reward: {
      calculated: {
        displayed: {
          2: 697630,
          11: 497910,
        },
      },
    },
  };
  const harness = await createUiHarness(t, {
    bootTeamOrders: {
      page: 1,
      pageSize: 50,
      total: 3,
      items: [
        teamOrderItem("p1", "unfinished", null),
        recent,
        teamOrderItem("p1", "too-old", oldTime.toISOString()),
      ],
      summary: { current: null, recent },
    },
  });
  const html = harness.document.getElementById("teamOrderArchiveList").innerHTML;
  assert.match(html, /team-order-card-heading[\s\S]*<time[^>]*>[^<]+<\/time>[\s\S]*>详情<\/a>/);
  assert.doesNotMatch(html, /完成时间/);
  assert.match(html, /提交[\s\S]*76/);
  assert.match(html, /刷新[\s\S]*45/);
  assert.match(html, /跳过[\s\S]*2/);
  assert.match(html, /经验[\s\S]*69,7630/);
  assert.match(html, /金币[\s\S]*49,7910/);
  assert.match(html, /href="\/artifacts\/p1\/team-orders\/team-order-20260724T000000000Z-aaaaaaaaaaaaaaaaaaaaaaaa\.html"/);
  assert.match(html, /target="_blank"[^>]*>详情<\/a>/);
  assert.doesNotMatch(html, /unfinished|too-old|打开 HTML/);
  assert.match(harness.document.getElementById("teamOrderPageText").textContent, /最近 7 天 · 1 条/);
});

test("system UI renders the calculated final reward stored by team-order archives", async (t) => {
  const recent = {
    ...teamOrderItem("p1", "rewarded-run", new Date(Date.now() - 60_000).toISOString()),
    reward: {
      calculated: {
        displayed: {
          2: 123,
          11: 456,
        },
      },
    },
  };
  const harness = await createUiHarness(t, {
    bootTeamOrders: {
      page: 1,
      pageSize: 20,
      total: 1,
      items: [recent],
      summary: { current: null, recent },
    },
  });

  const html = harness.document.getElementById("teamOrderArchiveList").innerHTML;
  assert.match(html, /经验[\s\S]*123/);
  assert.match(html, /金币[\s\S]*456/);
});

test("system UI renders ordinary and paid-renew rounds as two cards with independent values", async (t) => {
  const finishedAt = new Date(Date.now() - 60_000).toISOString();
  const ordinary = {
    ...teamOrderItem("p1", "ordinary-round", finishedAt),
    paidRenew: false,
    submittedCount: 1,
    refreshedCount: 2,
    skippedCount: 3,
    reward: { calculated: { displayed: { 2: 8_100, 11: 10_200 } } },
  };
  const renewed = {
    ...teamOrderItem("p1", "paid-renew-round", new Date(Date.parse(finishedAt) + 1_000).toISOString()),
    paidRenew: true,
    submittedCount: 4,
    refreshedCount: 5,
    skippedCount: 6,
    reward: { calculated: { displayed: { 2: 8_300, 11: 10_400 } } },
  };
  const harness = await createUiHarness(t, {
    bootTeamOrders: {
      page: 1,
      pageSize: 50,
      total: 2,
      items: [ordinary, renewed],
      summary: { current: null, recent: renewed },
    },
  });

  const html = harness.document.getElementById("teamOrderArchiveList").innerHTML;
  const ordinaryCard = html.match(/<article[^>]*data-team-order-id="ordinary-round"[\s\S]*?<\/article>/)?.[0] || "";
  const renewedCard = html.match(/<article[^>]*data-team-order-id="paid-renew-round"[\s\S]*?<\/article>/)?.[0] || "";

  assert.equal((html.match(/class="team-order-archive-item"/g) || []).length, 2);
  assert.match(ordinaryCard, /普通轮/);
  assert.match(ordinaryCard, /提交[\s\S]*1/);
  assert.match(ordinaryCard, /刷新[\s\S]*2/);
  assert.match(ordinaryCard, /跳过[\s\S]*3/);
  assert.match(ordinaryCard, /经验[\s\S]*8100/);
  assert.match(ordinaryCard, /金币[\s\S]*1,0200/);
  assert.doesNotMatch(ordinaryCard, /8300|1,0400/);
  assert.match(renewedCard, /元宝续开/);
  assert.match(renewedCard, /提交[\s\S]*4/);
  assert.match(renewedCard, /刷新[\s\S]*5/);
  assert.match(renewedCard, /跳过[\s\S]*6/);
  assert.match(renewedCard, /经验[\s\S]*8300/);
  assert.match(renewedCard, /金币[\s\S]*1,0400/);
  assert.doesNotMatch(renewedCard, /8100|1,0200/);
  assert.match(harness.document.getElementById("teamOrderPageText").textContent, /最近 7 天 · 2 条/);
});

class FakeElement {
  constructor(id = "", ownerDocument = null, tagName = "div") {
    this.id = id;
    this.ownerDocument = ownerDocument;
    this.tagName = tagName.toUpperCase();
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      contains: (name) => this.classes.has(name),
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      toggle: (name, enabled) => {
        if (enabled) this.classes.add(name);
        else this.classes.delete(name);
      },
    };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this._textContent = "";
    this._innerHTML = "";
  }

  set textContent(value) {
    this._textContent = String(value);
  }

  get textContent() {
    return this.children.length
      ? this.children.map((child) => child.textContent).join("")
      : this._textContent;
  }

  set innerHTML(value) {
    this._innerHTML = String(value);
    if (this.id === "profiles") {
      this.ownerDocument.updateProfileCards(this._innerHTML);
    }
  }

  get innerHTML() {
    if (this.children.length) return this.children.map(serializeFakeElement).join("");
    return this._innerHTML;
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
    if (name.startsWith("data-")) {
      const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      this.dataset[key] = normalized;
    }
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(event, handler) {
    const handlers = this.listeners.get(event) || [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  click() {
    for (const handler of this.listeners.get("click") || []) {
      handler({ target: this });
    }
  }

  showModal() {}
  close() {}
}

class FakeDocument {
  constructor() {
    this.elements = new Map();
    this.queueTabs = ["common", "secondary", "activities", "team-orders"].map((key) => {
      const element = new FakeElement(`queue-tab-${key}`, this, "button");
      element.dataset.queueTab = key;
      return element;
    });
  }

  get profileCards() {
    return this.getElementById("profileItems").children.filter((node) => node.classes.has("profile-card"));
  }

  createElement(tagName) {
    return new FakeElement("", this, tagName);
  }

  getElementById(id) {
    if (!this.elements.has(id)) {
      this.elements.set(id, new FakeElement(id, this));
    }
    return this.elements.get(id);
  }

  querySelectorAll(selector) {
    if (selector === ".profile-card") return this.profileCards;
    if (selector === "[data-queue-tab]") return this.queueTabs;
    return [];
  }

  addEventListener() {}

  updateProfileCards() {}
}

function serializeFakeElement(node) {
  const tagName = node.tagName.toLowerCase();
  const attributes = [];
  if (node.id) attributes.push(`id="${escapeFakeHtml(node.id)}"`);
  if (node.classes.size) attributes.push(`class="${escapeFakeHtml([...node.classes].join(" "))}"`);
  for (const [name, value] of node.attributes) {
    if (name === "id" || name === "class") continue;
    attributes.push(`${name}="${escapeFakeHtml(value)}"`);
  }
  if (node.hidden) attributes.push("hidden");
  const content = node.children.length
    ? node.children.map(serializeFakeElement).join("")
    : escapeFakeHtml(node.textContent || "");
  return `<${tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${content}</${tagName}>`;
}

function escapeFakeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data, status = 200) {
  const text = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return text;
    },
  };
}

function profileStatus(profileId) {
  return {
    summary: { profileId, risk: { experienceGuardBlocked: false } },
    projection: { garden: null, order: null },
    revision: `revision-${profileId}`,
  };
}

function teamOrderPage(profileId, runId) {
  const item = teamOrderItem(profileId, runId, new Date().toISOString());
  return {
    page: 1,
    pageSize: 50,
    total: 1,
    items: [item],
    summary: { current: item, recent: null },
  };
}

function teamOrderItem(profileId, runId, finishedAt) {
  const startedAt = finishedAt
    ? new Date(Date.parse(finishedAt) - 60_000).toISOString()
    : new Date().toISOString();
  return {
    runId,
    profileId,
    startedAt,
    finishedAt,
    finalStatus: finishedAt ? "completed" : "running",
    htmlName: "team-order-20260724T000000000Z-aaaaaaaaaaaaaaaaaaaaaaaa.html",
    readError: false,
  };
}

async function flushTasks() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function createUiHarness(t, options = {}) {
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const document = new FakeDocument();
  const pending = new Map();
  let raceMode = false;
  globalThis.document = document;
  globalThis.setInterval = () => 0;
  globalThis.fetch = async (url) => {
    const pathname = String(url);
    if (raceMode) {
      const match = pathname.match(/^\/api\/profiles\/(p1|p2)\/(status|team-orders)/);
      if (match) {
        const page = new URL(pathname, "http://local").searchParams.get("page");
        const key = page && page !== "1"
          ? `${match[1]}:${match[2]}:${page}`
          : `${match[1]}:${match[2]}`;
        const request = deferred();
        pending.set(key, request);
        return request.promise;
      }
    }
    if (pathname === "/api/runtime") {
      return jsonResponse({ activeTasks: [], activeByProfile: {}, lastTaskExits: {}, runningCount: 0 });
    }
    if (pathname === "/api/profiles") {
      return jsonResponse({
        profiles: [
          { id: "p1", label: "P1", hasCredentials: true, settings: {} },
          { id: "p2", label: "P2", hasCredentials: true, settings: {} },
        ],
      });
    }
    if (pathname === "/api/migration/legacy-credentials") {
      return jsonResponse({ exists: false, complete: false });
    }
    if (pathname === "/api/profiles/p1/status") {
      return jsonResponse(profileStatus("p1"));
    }
    if (pathname === "/api/profiles/p1/team-orders?page=1&pageSize=50") {
      return jsonResponse(options.bootTeamOrders || teamOrderPage("p1", "boot-p1"));
    }
    throw new Error(`Unexpected fetch ${pathname}`);
  };
  t.after(() => {
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    globalThis.setInterval = originalSetInterval;
  });

  await import(`./system/public/app.js?team-order-ui=${Date.now()}-${Math.random()}`);
  document.queueTabs.find((element) => element.dataset.queueTab === "team-orders").click();
  await flushTasks();
  return {
    document,
    pending,
    startRace() {
      raceMode = true;
    },
  };
}
