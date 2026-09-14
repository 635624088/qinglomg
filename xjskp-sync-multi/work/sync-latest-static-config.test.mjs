import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  downloadAndExtractLatestGamePackage,
  downloadStaticConfigResource,
  decodeCocosUuid,
  parseResourceVersionToken,
  resolveStaticConfigResource,
} from "./sync-latest-static-config.mjs";
import * as syncLatestStatic from "./sync-latest-static-config.mjs";

function octal(value, width) {
  return String(value.toString(8)).padStart(width - 1, "0") + "\0";
}

function tarFile(name, content) {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, "utf8");
  header.write(octal(0o644, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(body.length, 12), 124, "ascii");
  header.write(octal(0, 12), 136, "ascii");
  header.fill(0x20, 148, 156);
  header.write("0", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  header.write(octal(checksum, 8), 148, "ascii");
  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

function makeTar(files) {
  return Buffer.concat([
    ...Object.entries(files).map(([name, content]) => tarFile(name, content)),
    Buffer.alloc(1024, 0),
  ]);
}

function u16(value) {
  const out = Buffer.alloc(2);
  out.writeUInt16LE(value);
  return out;
}

function u32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function makeStoredZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const local = Buffer.concat([
      Buffer.from("504b0304", "hex"),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(body.length),
      u32(body.length),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
      body,
    ]);
    const central = Buffer.concat([
      Buffer.from("504b0102", "hex"),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(body.length),
      u32(body.length),
      u16(nameBuffer.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuffer,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.concat([
    Buffer.from("504b0506", "hex"),
    u16(0),
    u16(0),
    u16(centrals.length),
    u16(centrals.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, end]);
}

test("decodeCocosUuid expands Cocos compressed uuids", () => {
  assert.equal(
    decodeCocosUuid("35/DOBNNxcZLqQ4GwsYTOo"),
    "35fc3381-34dc-5c64-ba90-e06c2c6133a8",
  );
});

test("resolveStaticConfigResource builds the native g-data URL path", () => {
  const config = {
    nativeBase: "native",
    uuids: {
      3058: "35/DOBNNxcZLqQ4GwsYTOo",
    },
    paths: {
      3058: ["mo/zh/data/g-data", 0, 1],
    },
    versions: {
      native: [3058, "69b61"],
    },
  };

  assert.deepEqual(resolveStaticConfigResource(config, "resources-config-c83ac.json"), {
    id: 3058,
    resourcePath: "mo/zh/data/g-data",
    compressedUuid: "35/DOBNNxcZLqQ4GwsYTOo",
    uuid: "35fc3381-34dc-5c64-ba90-e06c2c6133a8",
    version: "69b61",
    versionSort: 0x69b61,
    nativePath: "assets/resources/native/35/35fc3381-34dc-5c64-ba90-e06c2c6133a8.69b61.text",
    sourcePath: "resources-config-c83ac.json",
  });
});

test("parseResourceVersionToken sorts decimal and hex-like resource versions", () => {
  assert.equal(parseResourceVersionToken("29829"), 29829);
  assert.equal(parseResourceVersionToken("69b61"), 0x69b61);
  assert.equal(parseResourceVersionToken(null), null);
});

test("downloadAndExtractLatestGamePackage downloads package, extracts tar game.js, and returns hash evidence", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "latest-game-package-"));
  try {
    const appId = "2021004163668677";
    const tar = makeTar({
      "game.js": "mo.DS.setSingle(\"G.ISyncData\",{}); gs.usrLand.plantBatch; gs.waterwheel.recv;",
      "resources/config.abc.json": "{\"paths\":{}}",
    });
    const pkg = makeStoredZip({
      "Manifest.xml": "<package><appVersion>999.1.2</appVersion></package>",
      [`${appId}.tar`]: tar,
    });
    const evidence = await downloadAndExtractLatestGamePackage({
      appId,
      packageUrl: "https://example.invalid/game.zip",
      packagePath: path.join(outDir, "game.bin"),
      extractDir: path.join(outDir, "game-pkg-latest"),
      fetchImpl: async () => new Response(pkg),
    });

    assert.equal(evidence.packageUrl, "https://example.invalid/game.zip");
    assert.equal(evidence.packageBytes, pkg.length);
    assert.equal(evidence.manifestAppVersion, "999.1.2");
    assert.equal(evidence.gameJsPath.endsWith("game-pkg-latest/tar/game.js") || evidence.gameJsPath.endsWith("game-pkg-latest\\tar\\game.js"), true);
    assert.match(evidence.packageSha256, /^[a-f0-9]{64}$/);
    assert.match(evidence.gameJsSha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(path.join(outDir, "game-pkg-latest", "tar", "game.js"), "utf8").includes("gs.waterwheel.recv"), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("resolvePackageResourceConfigModule derives resources config from package modules.json", () => {
  const resolved = syncLatestStatic.resolvePackageResourceConfigModule({
    main: [
      "assets/base/index.c56a5.js",
      "assets/resources/index.af581.js",
      "game.js",
    ],
  }, "modules.json");

  assert.deepEqual(resolved, {
    sourcePath: "modules.json",
    resourceBundleIndexPath: "assets/resources/index.af581.js",
    resourceConfigPath: "assets/resources/config.af581.json",
    resourceConfigVersionToken: "af581",
  });
});

test("downloadPackageResourceConfigFromModules downloads only the package-declared resources config", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "package-resource-config-"));
  try {
    fs.writeFileSync(path.join(outDir, "modules.json"), JSON.stringify({
      main: ["assets/resources/index.af581.js"],
    }), "utf8");
    fs.writeFileSync(path.join(outDir, "resources-config-c83ac.json"), JSON.stringify({
      nativeBase: "native",
      uuids: { 1: "35/DOBNNxcZLqQ4GwsYTOo" },
      paths: { 1: ["mo/zh/data/g-data", 0, 1] },
      versions: { native: [1, "69b61"] },
    }), "utf8");

    const fetchedUrls = [];
    const resourceConfig = {
      nativeBase: "native",
      uuids: { 2: "35/DOBNNxcZLqQ4GwsYTOo" },
      paths: { 2: ["mo/zh/data/g-data", 0, 1] },
      versions: { native: [2, "beef1"] },
    };
    const result = await syncLatestStatic.downloadPackageResourceConfigFromModules({
      modulesPath: path.join(outDir, "modules.json"),
      baseUrls: ["https://cdn.example/"],
      outDir,
      fetchImpl: async (url) => {
        fetchedUrls.push(url);
        if (url === "https://cdn.example/assets/resources/config.af581.json") {
          return new Response(JSON.stringify(resourceConfig));
        }
        return new Response("not found", { status: 404 });
      },
    });

    assert.deepEqual(fetchedUrls, ["https://cdn.example/assets/resources/config.af581.json"]);
    assert.equal(result.resourceConfigSource, "package-modules");
    assert.equal(result.resourceConfigVersionToken, "af581");
    assert.equal(result.resourceConfigUrl, "https://cdn.example/assets/resources/config.af581.json");
    assert.equal(result.resourceConfigPath, path.join(outDir, "resources-config-af581.json"));
    assert.equal(result.resource.version, "beef1");
    assert.equal(fs.existsSync(path.join(outDir, "resources-config-af581.json")), true);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("downloadPackageResourceConfigFromModules fails instead of falling back to local old resources config", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "package-resource-config-fail-"));
  try {
    fs.writeFileSync(path.join(outDir, "modules.json"), JSON.stringify({
      main: ["assets/resources/index.af581.js"],
    }), "utf8");
    fs.writeFileSync(path.join(outDir, "resources-config-c83ac.json"), JSON.stringify({
      nativeBase: "native",
      uuids: { 1: "35/DOBNNxcZLqQ4GwsYTOo" },
      paths: { 1: ["mo/zh/data/g-data", 0, 1] },
      versions: { native: [1, "69b61"] },
    }), "utf8");

    await assert.rejects(
      syncLatestStatic.downloadPackageResourceConfigFromModules({
        modulesPath: path.join(outDir, "modules.json"),
        baseUrls: ["https://cdn.example/"],
        outDir,
        fetchImpl: async () => new Response("missing", { status: 404 }),
      }),
      /Unable to download package resources config/,
    );
    assert.equal(fs.existsSync(path.join(outDir, "resources-config-af581.json")), false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("summarizeStaticConfigTables reports decoded and effective table counts", () => {
  const table = (ids) => ({
    colMap: { $: "id" },
    list: [{ v: Object.fromEntries(ids.map((id) => [String(id), {}])) }],
  });
  const summary = syncLatestStatic.summarizeStaticConfigTables({
    c_flower: table([-1, 23001, 23002]),
    c_flowerArt: table([-1, 3001]),
    c_flowerVase: table([-1, 4001, 4002]),
    c_item: table([-1, 7, 23001]),
  }, ["c_flower", "c_flowerArt", "c_flowerVase", "c_item", "missing"]);

  assert.deepEqual(summary, {
    c_flower: { present: true, rowCount: 3, effectiveRowCount: 2 },
    c_flowerArt: { present: true, rowCount: 2, effectiveRowCount: 1 },
    c_flowerVase: { present: true, rowCount: 3, effectiveRowCount: 2 },
    c_item: { present: true, rowCount: 3, effectiveRowCount: 2 },
    missing: { present: false, rowCount: 0, effectiveRowCount: 0 },
  });
});

test("diffStaticConfigTableCounts reports current minus baseline deltas", () => {
  assert.deepEqual(syncLatestStatic.diffStaticConfigTableCounts(
    {
      c_flower: { rowCount: 3, effectiveRowCount: 2 },
      c_flowerArt: { rowCount: 5, effectiveRowCount: 4 },
    },
    {
      c_flower: { rowCount: 8, effectiveRowCount: 7 },
      c_flowerArt: { rowCount: 5, effectiveRowCount: 4 },
      c_item: { rowCount: 10, effectiveRowCount: 9 },
    },
  ), {
    c_flower: { rowCountDelta: 5, effectiveRowCountDelta: 5 },
    c_flowerArt: { rowCountDelta: 0, effectiveRowCountDelta: 0 },
    c_item: { rowCountDelta: 10, effectiveRowCountDelta: 9 },
  });
});

test("downloadStaticConfigResource validates JSON before writing the isolated candidate file", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "candidate-static-config-"));
  try {
    const outputPath = path.join(outDir, "g-data.beef1.text");
    const resource = {
      version: "beef1",
      nativePath: "assets/resources/native/aa/file.beef1.text",
    };
    const result = await downloadStaticConfigResource({
      resource,
      baseUrls: ["https://cdn.example/"],
      outputPath,
      fetchImpl: async () => new Response("{}"),
    });
    assert.equal(result.configPath, outputPath);
    assert.equal(result.bytes, 2);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.readFileSync(outputPath, "utf8"), "{}");

    const invalidPath = path.join(outDir, "g-data.bad12.text");
    await assert.rejects(
      downloadStaticConfigResource({
        resource: { ...resource, version: "bad12" },
        baseUrls: ["https://cdn.example/"],
        outputPath: invalidPath,
        fetchImpl: async () => new Response("not-json"),
      }),
      /Unexpected token|JSON/,
    );
    assert.equal(fs.existsSync(invalidPath), false);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("collectAutomationInterfaceReferences scans production sources and excludes tests and package artifacts", () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), "automation-interface-scan-"));
  try {
    fs.mkdirSync(path.join(sourceDir, "nested"), { recursive: true });
    fs.mkdirSync(path.join(sourceDir, "game-pkg-latest", "tar"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceDir, "runner.mjs"),
      'const first = "gs.orderTeam.submitOrder"; const ignored = "gw.index.login";',
      "utf8",
    );
    fs.writeFileSync(
      path.join(sourceDir, "nested", "state.js"),
      "export const second = 'gs.waterwheel.recv';",
      "utf8",
    );
    fs.writeFileSync(path.join(sourceDir, "runner.test.mjs"), '"gs.test.only";', "utf8");
    fs.writeFileSync(path.join(sourceDir, "sync-latest-static-config.mjs"), '"gs.sync.only";', "utf8");
    fs.writeFileSync(path.join(sourceDir, "game-pkg-latest", "tar", "game.js"), '"gs.package.only";', "utf8");

    assert.deepEqual(
      syncLatestStatic.collectAutomationInterfaceReferences({ sourceDir }),
      ["gs.orderTeam.submitOrder", "gs.waterwheel.recv"],
    );
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test("compareAutomationInterfaceCompatibility distinguishes removals from historically unverified interfaces", () => {
  const audit = syncLatestStatic.compareAutomationInterfaceCompatibility({
    interfaces: [
      "gs.orderTeam.submitOrder",
      "gs.orderTeam.refreshOrder",
      "gs.actCyclicNote.enter",
    ],
    baselineGameJsSource: "gs.orderTeam.submitOrder gs.orderTeam.refreshOrder",
    latestGameJsSource: "gs.orderTeam.refreshOrder",
  });

  assert.deepEqual(audit.removedFromLatest, ["gs.orderTeam.submitOrder"]);
  assert.deepEqual(audit.preservedInLatest, ["gs.orderTeam.refreshOrder"]);
  assert.deepEqual(audit.unverified, ["gs.actCyclicNote.enter"]);
  assert.equal(audit.compatible, false);
});

test("auditBusinessConfigLoaders reports thrown and explicit compatibility failures without dumping loaded data", () => {
  const audit = syncLatestStatic.auditBusinessConfigLoaders("fixture.text", [
    {
      name: "healthy",
      load: () => ({ rows: new Map([[1, {}]]) }),
      validate: (value) => value.rows.size > 0 ? [] : ["rows-empty"],
    },
    {
      name: "explicit-incompatible",
      load: () => ({ compatible: false, reasons: ["missing-field:c_orderTeam.$orderRwdBase"] }),
    },
    {
      name: "throws",
      load: () => { throw new Error("missing c_item"); },
    },
  ]);

  assert.equal(audit.compatible, false);
  assert.deepEqual(audit.results, [
    { name: "healthy", compatible: true, reasons: [] },
    {
      name: "explicit-incompatible",
      compatible: false,
      reasons: ["missing-field:c_orderTeam.$orderRwdBase"],
    },
    { name: "throws", compatible: false, reasons: ["missing c_item"] },
  ]);
  assert.equal(JSON.stringify(audit).includes('"rows":'), false);
});

test("assertSyncCompatibility fails closed when interfaces were removed or a business loader is incompatible", () => {
  assert.throws(
    () => syncLatestStatic.assertSyncCompatibility({
      automationInterfaces: {
        compatible: false,
        removedFromLatest: ["gs.orderTeam.submitOrder"],
      },
      businessConfig: {
        compatible: false,
        results: [{ name: "teamOrder", compatible: false, reasons: ["orders-empty"] }],
      },
    }),
    (error) => {
      assert.equal(error.code, "SYNC_COMPATIBILITY_FAILED");
      assert.match(error.message, /gs\.orderTeam\.submitOrder/);
      assert.match(error.message, /teamOrder/);
      return true;
    },
  );
});

test("selectSyncProfile auto-selects one complete profile and requires an explicit id for multiple profiles", () => {
  const only = { id: "only", hasCredentials: true };
  assert.equal(syncLatestStatic.selectSyncProfile([only]), only);

  const profiles = [
    { id: "first", hasCredentials: true },
    { id: "second", hasCredentials: true },
    { id: "incomplete", hasCredentials: false },
  ];
  assert.equal(syncLatestStatic.selectSyncProfile(profiles, "second"), profiles[1]);
  assert.throws(
    () => syncLatestStatic.selectSyncProfile(profiles),
    /XJSKP_SYNC_PROFILE_ID/,
  );
  assert.throws(
    () => syncLatestStatic.selectSyncProfile(profiles, "missing"),
    /not found or incomplete/,
  );
});
