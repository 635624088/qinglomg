import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOrderStatusDocumentPayload,
  writeOrderStatusDocument,
} from "./order-status-document.mjs";

function makeOrderStatus() {
  return {
    satin: { exists: true, canFinish: true, isVideo: false, finishCnt: 1 },
    decorate: { exists: false, canFinish: false, isVideo: false },
    customer: {
      orders: [
        { npcId: 7, action: "submit", canSubmit: true, canFinish: true },
      ],
    },
    palace: { exists: false, canFinish: false },
  };
}

test("buildOrderStatusDocumentPayload preserves mappings, rules and injected history", () => {
  const runHistory = { startedAt: "2026-08-12T00:00:00.000Z", customerOrders: [] };
  const payload = buildOrderStatusDocumentPayload(makeOrderStatus(), {
    runHistory,
    now: new Date("2026-08-12T01:02:03.000Z"),
  });

  assert.equal(payload.updatedAt, "2026-08-12 09:02:03");
  assert.equal(payload.runHistory, runHistory);
  assert.deepEqual(payload.mapping, {
    satin: "orderFlowerTot.orderFlower.orderSatin",
    decorate: "orderFlowerTot.orderFlower.orderDecorate",
    customer: "orderCustomerTot.orderCustomer.orderMap",
    palace: "orderPalaceTot.orderPalace",
  });
  assert.match(payload.autoSubmitRule, /canFinish=true/);
  assert.match(payload.customerOrderRule, /temporary out of stock/);
  assert.match(payload.palaceOrderRule, /double gold/);
  assert.equal(Array.isArray(payload.pendingAutoSubmitActions), true);
  assert.equal(Array.isArray(payload.pendingCustomerOrderActions), true);
  assert.equal(Array.isArray(payload.pendingPalaceOrderActions), true);
  assert.equal(payload.satin.exists, true);
});

test("writeOrderStatusDocument keeps explicit path and structured logs", () => {
  const writes = [];
  const logs = [];
  const warnings = [];
  const mkdirs = [];
  const result = writeOrderStatusDocument(makeOrderStatus(), {
    env: {
      STATUS_DOC_DIR: "ignored",
      ORDER_STATUS_JSON_PATH: "custom/order-status.json",
    },
    fsModule: { mkdirSync: (...args) => mkdirs.push(args) },
    runHistory: { customerOrders: [] },
    now: new Date("2026-08-12T01:02:03.000Z"),
    writeStatusArtifacts(files) {
      writes.push(...files);
      return [{ path: files[0].path, ok: true, attempts: 1 }];
    },
    log: (line) => logs.push(JSON.parse(line)),
    warn: (line) => warnings.push(JSON.parse(line)),
  });

  assert.deepEqual(mkdirs, [["ignored", { recursive: true }]]);
  assert.equal(writes[0].path, "custom/order-status.json");
  assert.equal(JSON.parse(writes[0].content).updatedAt, "2026-08-12 09:02:03");
  assert.deepEqual(logs, [{ step: "orderStatusDocumentUpdated", jsonPath: "custom/order-status.json" }]);
  assert.deepEqual(warnings, []);
  assert.equal(result.jsonPath, "custom/order-status.json");
  assert.equal(result.writeResult.ok, true);
});

test("writeOrderStatusDocument reports atomic write failure and still emits updated log", () => {
  const logs = [];
  const warnings = [];
  writeOrderStatusDocument(makeOrderStatus(), {
    env: {},
    fsModule: { mkdirSync() {} },
    runHistory: {},
    now: new Date("2026-08-12T01:02:03.000Z"),
    writeStatusArtifacts(files) {
      return [{
        path: files[0].path,
        ok: false,
        attempts: 5,
        errorCode: "EPERM",
        errorMessage: "locked",
      }];
    },
    log: (line) => logs.push(JSON.parse(line)),
    warn: (line) => warnings.push(JSON.parse(line)),
  });

  assert.deepEqual(warnings, [{
    step: "orderStatusDocumentWriteError",
    path: "outputs/order-status.json",
    attempts: 5,
    errorCode: "EPERM",
    message: "locked",
  }]);
  assert.deepEqual(logs, [{ step: "orderStatusDocumentUpdated", jsonPath: "outputs/order-status.json" }]);
});

