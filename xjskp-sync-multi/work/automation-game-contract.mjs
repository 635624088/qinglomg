function iface(domain, name, argKeys = [], options = {}) {
  const [, namespace, method] = /^gs\.([^.]+)\.(.+)$/.exec(name) || [];
  return Object.freeze({
    iface: name,
    domain,
    evidence: options.dynamic ? "dynamic-schema" : options.literal ? "literal" : "schema",
    ...(options.literal ? {} : {
      argSchema: `G.GS.${namespace}Iface.IArg_${method}`,
      argKeys: Object.freeze([...argKeys].sort()),
    }),
  });
}

export const AUTOMATION_GAME_CONTRACT = Object.freeze({
  interfaces: Object.freeze([
    iface("session", "gs.index.login", [], { literal: true }),
    iface("session", "gs.usr.lazySync"),
    iface("session", "gs.usr.heartTick"),

    iface("garden", "gs.usrLand.refresh"),
    iface("garden", "gs.usrLand.plant", ["landId", "flowerId"]),
    iface("garden", "gs.usrLand.plantBatch", ["landIds", "flowerId"]),
    iface("garden", "gs.usrLand.water", ["landId"]),
    iface("garden", "gs.usrLand.waterBatch", ["landIds"]),
    iface("garden", "gs.usrLand.harvest", ["landId"]),
    iface("garden", "gs.usrLand.harvestOneKey"),
    iface("garden", "gs.usrLand.speedUpFree"),
    iface("cultivate", "gs.cultivate.upgrade", ["flowerId"]),

    iface("resident-order", "gs.orderFlower.enter"),
    iface("resident-order", "gs.orderFlower.finishOrder", ["boxId"]),
    iface("resident-order", "gs.orderFlower.finishSatinOrder", [], { literal: true }),
    iface("resident-order", "gs.orderFlower.finishDecorateOrder", [], { literal: true }),
    iface("customer-order", "gs.orderCustomer.genOrder", ["guestNpcIdList"]),
    iface("customer-order", "gs.orderCustomer.finishOrder", ["npcId"]),
    iface("customer-order", "gs.orderCustomer.rejectOrder", ["npcId"]),
    iface("customer-order", "gs.flowerArt.makeFlowerArt", ["vaseId", "flowersIds", "num"]),
    iface("palace-order", "gs.orderPalace.enter"),
    iface("palace-order", "gs.orderPalace.finishOrder"),
    iface("palace-order", "gs.orderPalace.refreshOrder"),
    iface("team-order", "gs.orderTeam.takeOrder", ["isAgree", "isCost"]),
    iface("team-order", "gs.orderTeam.submitOrder"),
    iface("team-order", "gs.orderTeam.refreshOrder"),
    iface("team-order", "gs.orderTeam.recvRwd"),
    iface("team-order", "gs.orderTeam.storeOrder"),
    iface("team-order", "gs.orderTeam.takeStoredOrder", ["npcId"]),

    iface("flower-rack", "gs.flowerRack.sell", ["rackId", "iid", "num"]),
    iface("flower-rack", "gs.flowerRack.recvSellMoney", ["rackId"]),
    iface("flower-rack", "gs.flowerRack.recvOneKey", ["standId"]),
    iface("material-shop", "gs.shopCultivate.enter"),
    iface("material-shop", "gs.shopCultivate.refresh"),
    iface("material-shop", "gs.shopCultivate.buy", ["shopId"]),
    iface("material-shop", "gs.shopCultivate.buyOneKey", [], { literal: true }),

    iface("family-land", "gs.fml.enter", [], { literal: true }),
    iface("family-land", "gs.fmlLand.harvest", ["landIds"]),
    iface("family-land", "gs.fmlLand.harvestAll"),
    iface("free-water", "gs.freeWater.recv", ["idx"]),
    iface("waterwheel", "gs.waterwheel.enter"),
    iface("waterwheel", "gs.waterwheel.skip"),
    iface("waterwheel", "gs.waterwheel.recv"),

    iface("pearl", "gs.pearl.recvDailyFree"),
    iface("pearl", "gs.pearl.getRecommendList"),
    iface("pearl", "gs.pearl.getHireStateByUids", ["uids"]),
    iface("pearl", "gs.pearl.refresh"),
    iface("pearl", "gs.pearlPlace.hire", ["placeId", "dstUid"]),
    iface("pearl", "gs.pearlPlace.recv", ["placeId"]),
    iface("pearl", "gs.pearlPlace.recvOneKey"),

    iface("main-task", "gs.taskMain.recv", [], { literal: true }),
    iface("cyclic-note", "gs.actCyclicNote.enter", ["batchId"], { dynamic: true }),
    iface("cyclic-note", "gs.actCyclicNote.recvTaskRwd", ["batchId", "taskId"]),
    iface("cyclic-story", "gs.actCyclicStory.enter", ["batchId"], { dynamic: true }),
    iface("cyclic-story", "gs.actCyclicStory.recvOrderRwd", ["batchId", "orderIdx"]),
  ]),
  responseSchemaRoots: Object.freeze([
    "G.ISyncData",
    "G.IUsrTot",
    "G.IUsrLandTot",
    "G.ICultivateTot",
    "G.IOrderFlowerTot",
    "G.IOrderCustomerTot",
    "G.IOrderPalaceTot",
    "G.IOrderTeamTot",
    "G.IFlowerArtTot",
    "G.IFlowerRackTot",
    "G.IShopCultivate",
    "G.IFmlTot",
    "G.IWaterwheel",
    "G.IFreeWater",
    "G.IPearlTot",
    "G.ITaskTot",
    "G.IActTot",
    "G.IStatisticsTot",
    "G.IVideoDouble",
    "G.IRchgTot",
  ]),
});

function splitTopLevelFields(literal) {
  const fields = [];
  let start = 1;
  let quote = null;
  let escaped = false;
  let depth = 0;
  for (let index = 1; index < literal.length - 1; index += 1) {
    const ch = literal[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      fields.push(literal.slice(start, index));
      start = index + 1;
    }
  }
  if (start < literal.length - 1) fields.push(literal.slice(start, -1));
  return fields;
}

function parseSchemaLiteral(literal) {
  const schema = {};
  for (const field of splitTopLevelFields(literal)) {
    const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]+?)\s*$/.exec(field);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) schema[key] = Number(rawValue);
    else if (rawValue === "true" || rawValue === "false") schema[key] = rawValue === "true";
    else if (rawValue === "null") schema[key] = null;
    else if (
      (rawValue.startsWith('"') && rawValue.endsWith('"'))
      || (rawValue.startsWith("'") && rawValue.endsWith("'"))
    ) {
      schema[key] = rawValue.slice(1, -1);
    } else {
      schema[key] = rawValue;
    }
  }
  return schema;
}

function findObjectEnd(source, objectStart) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = objectStart; index < source.length; index += 1) {
    const ch = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}" && --depth === 0) return index;
  }
  return -1;
}

export function extractGameProtocolEvidence(sourceText) {
  const source = String(sourceText || "");
  const literalInterfaces = new Set(source.match(/\bgs(?:\.[A-Za-z0-9_$]+){2,}\b/g) || []);
  const argSchemas = new Map();
  const allSchemas = new Set();
  const needle = 'mo.DS.setSingle("';
  let position = 0;
  while ((position = source.indexOf(needle, position)) >= 0) {
    const nameStart = position + needle.length;
    const nameEnd = source.indexOf('"', nameStart);
    if (nameEnd < 0) break;
    const name = source.slice(nameStart, nameEnd);
    const objectStart = source.indexOf("{", nameEnd);
    if (objectStart < 0) break;
    const objectEnd = findObjectEnd(source, objectStart);
    if (objectEnd < 0) break;
    allSchemas.add(name);
    if (/^G\.GS\.[A-Za-z0-9_$]+Iface\.IArg_[A-Za-z0-9_$]+$/.test(name)) {
      argSchemas.set(name, parseSchemaLiteral(source.slice(objectStart, objectEnd + 1)));
    }
    position = objectEnd + 1;
  }
  return { literalInterfaces, argSchemas, allSchemas };
}

export function auditAutomationGameContract(sourceText, contract = AUTOMATION_GAME_CONTRACT) {
  const evidence = extractGameProtocolEvidence(sourceText);
  const reasons = [];
  const interfaceResults = [];
  for (const entry of contract.interfaces || []) {
    if (entry.evidence === "literal") {
      const present = evidence.literalInterfaces.has(entry.iface);
      if (!present) reasons.push(`missing-interface:${entry.iface}`);
      interfaceResults.push({ ...entry, present });
      continue;
    }
    const schema = evidence.argSchemas.get(entry.argSchema);
    const present = Boolean(schema);
    if (!present) {
      reasons.push(`missing-argument-schema:${entry.argSchema}`);
    } else {
      const expected = [...(entry.argKeys || [])].sort();
      const actual = Object.keys(schema).sort();
      if (expected.join("\0") !== actual.join("\0")) {
        reasons.push(`argument-schema-fields-changed:${entry.argSchema}:expected=${expected.join(",")}:actual=${actual.join(",")}`);
      }
    }
    interfaceResults.push({ ...entry, present });
  }
  for (const schemaName of contract.responseSchemaRoots || []) {
    if (!evidence.allSchemas.has(schemaName)) reasons.push(`missing-response-schema:${schemaName}`);
  }
  return {
    compatible: reasons.length === 0,
    reasons,
    interfaceResults,
    responseSchemaResults: (contract.responseSchemaRoots || []).map((schemaName) => ({
      schemaName,
      present: evidence.allSchemas.has(schemaName),
    })),
  };
}
