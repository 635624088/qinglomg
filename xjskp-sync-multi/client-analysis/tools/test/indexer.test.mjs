import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseJavaScript } from "../src/parser.mjs";
import { buildBasicIndex, writeGeneratedArtifacts } from "../src/indexer.mjs";
import { createSnippet } from "../src/snippets.mjs";
import { publishClientVersion } from "../src/publish.mjs";
import { buildBusinessMap, writeBusinessMapArtifacts } from "../src/business-map.mjs";

const fixtureSource = [
  "const FooCtrl = class {};",
  "const PBarDlg = class {};",
  "gs.usrLand.plantBatch(1);",
  "gs[\"usrLand\"].plantBatch(1);",
  "gs[`usrLand`].plantBatch(1);",
  "const table = c_flower;",
  "gs[name](2);"
].join("\n");

async function withTempDir(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-basic-index-"));
  try {
    return await callback(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function findEntry(entries, name) {
  const entry = entries.find((candidate) => candidate.name === name);
  assert.ok(entry, `missing ${name}`);
  return entry;
}

test("buildBasicIndex emits sorted unique source-ranged evidence and unresolved dynamic access", () => {
  const ast = parseJavaScript(fixtureSource);
  const index = buildBasicIndex({ source: fixtureSource, ast });

  assert.deepEqual(index.controllers.map((entry) => entry.name), ["FooCtrl"]);
  assert.deepEqual(index.dialogs.map((entry) => entry.name), ["PBarDlg"]);
  assert.deepEqual(index.interfaces.map((entry) => entry.name), ["gs.usrLand.plantBatch"]);
  assert.deepEqual(index.configTables.map((entry) => entry.name), ["c_flower"]);
  assert.deepEqual(index.callSites.map((entry) => entry.name), [
    "gs.usrLand.plantBatch",
    "gs.usrLand.plantBatch",
    "gs.usrLand.plantBatch"
  ]);
  assert.deepEqual(index.unresolved.map((entry) => entry.name), ["gs[name]"]);

  for (const group of Object.values(index)) {
    for (const entry of group) {
      assert.equal(typeof entry.name, "string");
      assert.equal(Number.isInteger(entry.start), true);
      assert.equal(Number.isInteger(entry.end), true);
      assert.equal(fixtureSource.slice(entry.start, entry.end).length > 0, true);
    }
  }
  assert.equal(findEntry(index.unresolved, "gs[name]").reason, "dynamic-computed-property");
});

test("buildBasicIndex discovers client symbols preserved in static string literals", () => {
  const source = [
    'System.register("chunks:///_virtual/GridArrCtrl.ts", [], function () {});',
    'const dialog = "FlowerDetailDlg";',
    'const table = "c_flower";',
    'const iface = "gs.usrLand.plantBatch";',
    'request("gs.usrLand.plantBatch");'
  ].join("\n");
  const index = buildBasicIndex({ source, ast: parseJavaScript(source) });

  assert.deepEqual(index.controllers.map((entry) => entry.name), ["GridArrCtrl"]);
  assert.deepEqual(index.dialogs.map((entry) => entry.name), ["FlowerDetailDlg"]);
  assert.deepEqual(index.configTables.map((entry) => entry.name), ["c_flower"]);
  assert.deepEqual(index.interfaces.map((entry) => entry.name), ["gs.usrLand.plantBatch"]);
  assert.deepEqual(index.callSites.map((entry) => entry.name), ["gs.usrLand.plantBatch"]);
});

test("indexes and snippets expose original UTF-8 byte ranges after multibyte source", () => {
  const source = [
    'const label = "中文😀";',
    "const FooCtrl = class {};",
    "gs.usrLand.plantBatch(1);",
    "gs[name](2);"
  ].join("\n");
  const sourceBytes = Buffer.from(source, "utf8");
  const index = buildBasicIndex({ source, ast: parseJavaScript(source) });
  const expected = [
    [findEntry(index.controllers, "FooCtrl"), "FooCtrl"],
    [findEntry(index.interfaces, "gs.usrLand.plantBatch"), "gs.usrLand.plantBatch"],
    [findEntry(index.unresolved, "gs[name]"), "gs[name]"]
  ];

  for (const [entry, expectedContent] of expected) {
    const expectedBytes = Buffer.from(expectedContent, "utf8");
    const expectedStart = sourceBytes.indexOf(expectedBytes);
    assert.notEqual(expectedStart, -1);
    assert.equal(entry.start, expectedStart);
    assert.equal(entry.end, expectedStart + expectedBytes.length);
    const snippet = createSnippet({ source, entry });
    assert.equal(snippet.content, sourceBytes.subarray(entry.start, entry.end).toString("utf8"));
  }

  assert.equal(findEntry(index.unresolved, "gs[name]").name, "gs[name]");
  const businessMap = buildBusinessMap(index);
  for (const [entry] of expected) {
    const node = businessMap.nodes.find((candidate) => candidate.name === entry.name
      && candidate.start === entry.start && candidate.end === entry.end);
    assert.ok(node, `missing byte-ranged business node for ${entry.name}`);
  }
});

test("snippets use stable SHA256-prefixed names and original source byte slices", () => {
  const ast = parseJavaScript(fixtureSource);
  const controller = findEntry(buildBasicIndex({ source: fixtureSource, ast }).controllers, "FooCtrl");
  const first = createSnippet({ source: fixtureSource, entry: controller });
  const second = createSnippet({ source: fixtureSource, entry: controller });

  assert.deepEqual(second, first);
  assert.match(first.fileName, /^[a-f0-9]{16}\.js$/);
  assert.equal(first.sha256, createHash("sha256").update(first.content).digest("hex"));
  assert.equal(first.content, Buffer.from(fixtureSource).subarray(controller.start, controller.end).toString("utf8"));
});

test("fixture publication writes reparsable formatted source and all base generated artifacts", async () => {
  await withTempDir(async (analysisRoot) => {
    const ast = parseJavaScript(fixtureSource);
    const input = {
      appVersion: "fixture-1",
      sourceSha256: createHash("sha256").update(fixtureSource).digest("hex"),
      sourceSize: Buffer.byteLength(fixtureSource),
      sourceText: fixtureSource
    };
    const published = await publishClientVersion({
      analysisRoot,
      input,
      toolVersion: "1.0.0",
      build: ({ tempDir }) => writeGeneratedArtifacts({
        generatedDir: path.join(tempDir, "generated"),
        source: fixtureSource,
        ast
      }).then((index) => writeBusinessMapArtifacts({
        generatedDir: path.join(tempDir, "generated"),
        reportsDir: path.join(tempDir, "generated-reports"),
        indexes: index
      }))
    });
    const generatedDir = path.join(published.versionDir, "generated");
    const expected = [
      "game.formatted.js",
      "controllers.json",
      "dialogs.json",
      "interfaces.json",
      "config-tables.json",
      "call-sites.json",
      "business-map.json",
      "unresolved.json",
      path.join("snippets", "index.json")
    ];
    for (const relativePath of expected) {
      assert.equal((await fs.stat(path.join(generatedDir, relativePath))).isFile(), true);
    }
    const formattedSource = await fs.readFile(path.join(generatedDir, "game.formatted.js"), "utf8");
    assert.doesNotThrow(() => parseJavaScript(formattedSource));
    const snippetIndex = JSON.parse(await fs.readFile(path.join(generatedDir, "snippets", "index.json"), "utf8"));
    assert.equal(snippetIndex.length > 0, true);
    assert.equal((await fs.stat(path.join(generatedDir, "snippets", snippetIndex[0].fileName))).isFile(), true);
    assert.equal((await fs.stat(path.join(published.versionDir, "generated-reports", "business-catalog.md"))).isFile(), true);
  });
});
