import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  auditGameCodeCompatibility,
  collectProductionInterfaceReferences,
  extractGameSchemas,
} from "./game-code-compatibility.mjs";

test("extracts production interfaces while excluding tests and packaged artifacts", async (t) => {
  const sourceDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-code-compat-"));
  t.after(() => fsp.rm(sourceDir, { recursive: true, force: true }));
  await fsp.mkdir(path.join(sourceDir, "runtime"));
  await fsp.mkdir(path.join(sourceDir, "feature"));
  await fsp.writeFile(path.join(sourceDir, "feature", "run.mjs"), 'call("gs.usrLand.plant"); call(`gs.freeWater.recv`);', "utf8");
  await fsp.writeFile(path.join(sourceDir, "feature", "run.test.mjs"), 'call("gs.test.only")', "utf8");
  await fsp.writeFile(path.join(sourceDir, "runtime", "old.js"), 'call("gs.runtime.old")', "utf8");

  assert.deepEqual(collectProductionInterfaceReferences({ sourceDir }), ["gs.freeWater.recv", "gs.usrLand.plant"]);
});

test("fails closed when a production interface is removed but accepts a dynamic interface proven by IArg schema", () => {
  const baseline = gameSource({
    interfaces: ["gs.usrLand.plant"],
    schemas: baseSchemas(),
  });
  const removed = gameSource({ schemas: baseSchemas() });
  const removedAudit = auditGameCodeCompatibility({
    baselineGameJsSource: baseline,
    candidateGameJsSource: removed,
    interfaces: ["gs.usrLand.plant"],
    requiredSchemas: ["G.ISyncData"],
  });
  assert.equal(removedAudit.status, "incompatible");
  assert.match(removedAudit.reasons.join("\n"), /removed-interface:gs\.usrLand\.plant/);

  const dynamic = gameSource({
    schemas: {
      ...baseSchemas(),
      "G.GS.usrLandIface.IArg_plant": { landId: 0, flowerId: 1 },
    },
  });
  const dynamicAudit = auditGameCodeCompatibility({
    baselineGameJsSource: baseline,
    candidateGameJsSource: dynamic,
    interfaces: ["gs.usrLand.plant"],
    requiredSchemas: ["G.ISyncData"],
  });
  assert.equal(dynamicAudit.status, "compatible");
  assert.equal(dynamicAudit.interfaces.provenByIArg.includes("gs.usrLand.plant"), true);
});

test("fails on required or reachable schema removal and field index or type drift", () => {
  const baselineSchemas = baseSchemas();
  for (const [label, mutate, reasonPattern] of [
    ["root removed", (schemas) => delete schemas["G.ISyncData"], /missing-schema:G\.ISyncData/],
    ["dependency removed", (schemas) => delete schemas["G.IUsr"], /missing-schema:G\.IUsr/],
    ["index changed", (schemas) => { schemas["G.IUsr"].level = "9:number"; }, /schema-field-index-changed:G\.IUsr\.level/],
    ["type changed", (schemas) => { schemas["G.IUsr"].level = "1:string"; }, /schema-field-type-changed:G\.IUsr\.level/],
  ]) {
    const candidateSchemas = structuredClone(baselineSchemas);
    mutate(candidateSchemas);
    const audit = auditGameCodeCompatibility({
      baselineGameJsSource: gameSource({ schemas: baselineSchemas }),
      candidateGameJsSource: gameSource({ schemas: candidateSchemas }),
      interfaces: [],
      requiredSchemas: ["G.ISyncData"],
    });
    assert.equal(audit.status, "incompatible", label);
    assert.match(audit.reasons.join("\n"), reasonPattern, label);
  }
});

test("allows additive interfaces, schemas, and fields without weakening existing contracts", () => {
  const candidateSchemas = {
    ...baseSchemas(),
    "G.IAdded": { id: 0 },
  };
  candidateSchemas["G.IUsr"].nickname = "2:string";
  const audit = auditGameCodeCompatibility({
    baselineGameJsSource: gameSource({ schemas: baseSchemas() }),
    candidateGameJsSource: gameSource({ interfaces: ["gs.newFeature.enter"], schemas: candidateSchemas }),
    interfaces: [],
    requiredSchemas: ["G.ISyncData"],
  });
  assert.equal(audit.status, "compatible");
  assert.deepEqual(audit.reasons, []);
});

test("extractGameSchemas fails closed on malformed required schema declarations", () => {
  const source = 'mo.DS.setSingle("G.ISyncData",{usr:"0:G.IUsr"});';
  assert.deepEqual(extractGameSchemas(source)["G.ISyncData"], { usr: "0:G.IUsr" });
  const audit = auditGameCodeCompatibility({
    baselineGameJsSource: source,
    candidateGameJsSource: 'mo.DS.setSingle("G.ISyncData",notAStandaloneObject);',
    interfaces: [],
    requiredSchemas: ["G.ISyncData"],
  });
  assert.equal(audit.status, "incompatible");
  assert.match(audit.reasons.join("\n"), /missing-schema:G\.ISyncData/);
});

function baseSchemas() {
  return {
    "G.ISyncData": { usr: "0:G.IUsr" },
    "G.IUsr": { id: "0:number", level: "1:number" },
  };
}

function gameSource({ interfaces = [], schemas = {} } = {}) {
  return [
    ...interfaces.map((value) => `register(${JSON.stringify(value)});`),
    ...Object.entries(schemas).map(([name, value]) => `mo.DS.setSingle(${JSON.stringify(name)},${JSON.stringify(value)});`),
  ].join("");
}
