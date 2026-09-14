import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTOMATION_GAME_CONTRACT,
  auditAutomationGameContract,
  extractGameProtocolEvidence,
} from "./automation-game-contract.mjs";

const fixture = [
  'mo.DS.setSingle("G.GS.usrLandIface.IArg_plant",{landId:0,flowerId:1});',
  'mo.DS.setSingle("G.GS.actCyclicNoteIface.IArg_enter",{batchId:0});',
  'client.request("gs.usrLand.plant", {landId: 1, flowerId: 2});',
].join("\n");

test("extractGameProtocolEvidence extracts literal interfaces and IArg schemas", () => {
  const evidence = extractGameProtocolEvidence(fixture);
  assert.equal(evidence.literalInterfaces.has("gs.usrLand.plant"), true);
  assert.deepEqual(
    evidence.argSchemas.get("G.GS.usrLandIface.IArg_plant"),
    { landId: 0, flowerId: 1 },
  );
  assert.deepEqual(
    evidence.argSchemas.get("G.GS.actCyclicNoteIface.IArg_enter"),
    { batchId: 0 },
  );
});

test("contract records cyclic enter as dynamic schema evidence", () => {
  const cyclicEnter = AUTOMATION_GAME_CONTRACT.interfaces.find(
    (entry) => entry.iface === "gs.actCyclicNote.enter",
  );
  assert.deepEqual(cyclicEnter, {
    iface: "gs.actCyclicNote.enter",
    domain: "cyclic-note",
    evidence: "dynamic-schema",
    argSchema: "G.GS.actCyclicNoteIface.IArg_enter",
    argKeys: ["batchId"],
  });
});

test("contract covers every production interface reference found by the legacy scanner", () => {
  const names = new Set(AUTOMATION_GAME_CONTRACT.interfaces.map((entry) => entry.iface));
  for (const iface of [
    "gs.flowerRack.recvOneKey",
    "gs.fmlLand.harvestAll",
    "gs.orderPalace.refreshOrder",
    "gs.shopCultivate.buyOneKey",
    "gs.usrLand.harvestOneKey",
  ]) assert.equal(names.has(iface), true, iface);
});

test("audit accepts dynamic interface when matching IArg schema exists", () => {
  const contract = {
    interfaces: [{
      iface: "gs.actCyclicNote.enter",
      domain: "cyclic-note",
      evidence: "dynamic-schema",
      argSchema: "G.GS.actCyclicNoteIface.IArg_enter",
      argKeys: ["batchId"],
    }],
    responseSchemaRoots: [],
  };
  const report = auditAutomationGameContract(fixture, contract);
  assert.equal(report.compatible, true);
  assert.deepEqual(report.reasons, []);
});

test("audit rejects missing or changed required argument schema", () => {
  const contract = {
    interfaces: [{
      iface: "gs.usrLand.plant",
      domain: "garden",
      evidence: "schema",
      argSchema: "G.GS.usrLandIface.IArg_plant",
      argKeys: ["landId", "flowerId"],
    }],
    responseSchemaRoots: ["G.ISyncData"],
  };
  const changed = fixture.replace("{landId:0,flowerId:1}", "{landId:0,seedId:1}");
  const report = auditAutomationGameContract(changed, contract);
  assert.equal(report.compatible, false);
  assert.deepEqual(report.reasons, [
    "argument-schema-fields-changed:G.GS.usrLandIface.IArg_plant:expected=flowerId,landId:actual=landId,seedId",
    "missing-response-schema:G.ISyncData",
  ]);
});
