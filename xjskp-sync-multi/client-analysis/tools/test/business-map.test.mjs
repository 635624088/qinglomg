import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildBusinessMap, writeBusinessMapArtifacts } from "../src/business-map.mjs";

const indexes = {
  controllers: [
    { name: "MysteryCtrl", start: 5, end: 16 },
    { name: "FlowerActCtrl", start: 20, end: 33 },
    { name: "ActCtrl", start: 40, end: 47 },
    { name: "LandCtrl", start: 50, end: 58 }
  ],
  dialogs: [
    { name: "PFlowerActDlg", start: 60, end: 73 },
    { name: "PActDlg", start: 80, end: 87 },
    { name: "PLandDlg", start: 90, end: 98 }
  ],
  interfaces: [
    { name: "gs.flowerAct.open", start: 100, end: 117 },
    { name: "gs.act.list", start: 120, end: 131 },
    { name: "gs.usrLand.plantBatch", start: 140, end: 161 }
  ],
  configTables: [
    { name: "c_flowerAct", start: 170, end: 181 },
    { name: "c_act", start: 190, end: 195 },
    { name: "c_land", start: 200, end: 206 }
  ],
  callSites: [
    { name: "gs.flowerAct.open", start: 210, end: 227 },
    { name: "gs.usrLand.plantBatch", start: 230, end: 251 }
  ],
  unresolved: [
    { name: "gs[name]", start: 260, end: 268, reason: "dynamic-computed-property" }
  ]
};

test("buildBusinessMap produces stable evidence, call edges, complete classification, and activity distinctions", () => {
  const map = buildBusinessMap(indexes);

  assert.deepEqual(map.nodes.map((node) => node.id), [...map.nodes.map((node) => node.id)].sort());
  assert.deepEqual(map.edges.map((edge) => edge.id), [...map.edges.map((edge) => edge.id)].sort());
  assert.deepEqual(map.domains.map((domain) => domain.id), [...map.domains.map((domain) => domain.id)].sort());

  const discovered = Object.values(indexes).flat().length;
  assert.equal(map.nodes.length, discovered);
  assert.equal(map.statistics.discovered, discovered);
  assert.equal(map.statistics.classified + map.statistics.unclassified, discovered);
  assert.equal(map.unclassified.length, 2);
  assert.equal(map.nodes.find((node) => node.name === "MysteryCtrl").reason, "no-client-domain-evidence");
  assert.equal(map.nodes.find((node) => node.name === "gs[name]").reason, "missing-static-evidence");
  assert.equal(map.nodes.find((node) => node.name === "gs[name]").sourceReason, "dynamic-computed-property");
  assert.deepEqual(map.statistics.unclassifiedByReason, {
    "missing-static-evidence": 1,
    "no-client-domain-evidence": 1
  });

  const garden = map.domains.find((domain) => domain.id === "garden");
  assert.ok(garden);
  assert.equal(garden.evidenceKinds.includes("controller"), true);
  assert.equal(garden.evidenceKinds.includes("interface"), true);
  assert.equal(garden.nodeIds.length >= 4, true);

  assert.equal(map.nodes.find((node) => node.name === "ActCtrl").domainId, "activity-framework");
  assert.equal(map.nodes.find((node) => node.name === "PActDlg").domainId, "activity-framework");
  assert.equal(map.nodes.find((node) => node.name === "gs.act.list").domainId, "activity-framework");
  assert.equal(map.nodes.find((node) => node.name === "c_act").domainId, "activity-framework");
  assert.equal(map.nodes.find((node) => node.name === "FlowerActCtrl").domainId, "activity-instance:flower");
  assert.equal(map.nodes.find((node) => node.name === "PFlowerActDlg").domainId, "activity-instance:flower");
  assert.equal(map.nodes.find((node) => node.name === "gs.flowerAct.open").domainId, "activity-instance:flower");
  assert.equal(map.nodes.find((node) => node.name === "c_flowerAct").domainId, "activity-instance:flower");

  assert.deepEqual(map.edges.map((edge) => edge.type), ["calls", "calls"]);
  assert.equal(map.edges.every((edge) => edge.to.startsWith("interface:")), true);
});

test("writeBusinessMapArtifacts writes only generated business artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-business-map-"));
  try {
    const generatedDir = path.join(root, "generated");
    const reportsDir = path.join(root, "generated-reports");
    const map = await writeBusinessMapArtifacts({ generatedDir, reportsDir, indexes, appVersion: "fixture-1" });
    assert.equal((await fs.stat(path.join(generatedDir, "business-map.json"))).isFile(), true);
    const report = await fs.readFile(path.join(reportsDir, "business-catalog.md"), "utf8");
    assert.match(report, /garden/);
    assert.match(report, /activity-framework/);
    const unclassifiedReport = await fs.readFile(path.join(reportsDir, "unclassified.md"), "utf8");
    assert.match(unclassifiedReport, /客户端版本限定：`fixture-1`/);
    assert.match(unclassifiedReport, /未分类总数：2/);
    assert.match(unclassifiedReport, /missing-static-evidence \| 1/);
    assert.match(unclassifiedReport, /no-client-domain-evidence \| 1/);
    const mysteryPosition = unclassifiedReport.indexOf("controller:MysteryCtrl:5:16");
    const unresolvedPosition = unclassifiedReport.indexOf("unresolved:gs[name]:260:268");
    assert.equal(mysteryPosition >= 0, true);
    assert.equal(unresolvedPosition > mysteryPosition, true);
    assert.equal(map.statistics.unclassified, 2);
    await assert.rejects(fs.stat(path.join(root, "docs", "client-business")), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("writeBusinessMapArtifacts writes a deterministic zero-unclassified report", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-business-map-empty-"));
  try {
    const generatedDir = path.join(root, "generated");
    const reportsDir = path.join(root, "generated-reports");
    const classifiedIndexes = {
      controllers: [{ name: "LandCtrl", start: 1, end: 9 }]
    };

    await writeBusinessMapArtifacts({ generatedDir, reportsDir, indexes: classifiedIndexes, appVersion: "fixture-zero" });
    const first = await fs.readFile(path.join(reportsDir, "unclassified.md"), "utf8");
    await writeBusinessMapArtifacts({ generatedDir, reportsDir, indexes: classifiedIndexes, appVersion: "fixture-zero" });
    const second = await fs.readFile(path.join(reportsDir, "unclassified.md"), "utf8");

    assert.equal(second, first);
    assert.match(first, /客户端版本限定：`fixture-zero`/);
    assert.match(first, /未分类总数：0/);
    assert.match(first, /无未分类发现项/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("unclassified report uses locale-independent node ordering for prefix identifiers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-business-map-order-"));
  try {
    const generatedDir = path.join(root, "generated");
    const reportsDir = path.join(root, "generated-reports");
    const prefixIndexes = {
      callSites: [
        { name: "gs.mystery.browseWeb", start: 20, end: 40 },
        { name: "gs.mystery.browseWeb2", start: 50, end: 71 }
      ]
    };

    await writeBusinessMapArtifacts({ generatedDir, reportsDir, indexes: prefixIndexes, appVersion: "fixture-order" });
    const report = await fs.readFile(path.join(reportsDir, "unclassified.md"), "utf8");
    const browseWeb = report.indexOf("call-site:gs.mystery.browseWeb:20:40");
    const browseWeb2 = report.indexOf("call-site:gs.mystery.browseWeb2:50:71");
    assert.equal(browseWeb2 >= 0, true);
    assert.equal(browseWeb > browseWeb2, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
