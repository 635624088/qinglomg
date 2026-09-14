import fs from "node:fs";

import {
  getAutoSubmitCustomerOrderActions,
  getAutoSubmitOrderActions,
  getAutoSubmitPalaceOrderActions,
} from "./order-state.mjs";
import { describeCustomerOrderAction } from "./run-history.mjs";
import { formatDateTime } from "./status-format.mjs";
import { buildStatusArtifactFingerprint } from "./status-artifact-fingerprint.mjs";

const ORDER_STATUS_MAPPING = Object.freeze({
  satin: "orderFlowerTot.orderFlower.orderSatin",
  decorate: "orderFlowerTot.orderFlower.orderDecorate",
  customer: "orderCustomerTot.orderCustomer.orderMap",
  palace: "orderPalaceTot.orderPalace",
});

const AUTO_SUBMIT_RULE = "satin/decorate completion count uses home-popup cntMap first and business-statistics fallback; submit only when canFinish=true, isVideo=false, and this cycle will not advance resident board total to 50/100";
const CUSTOMER_ORDER_RULE = "derive flower-shop coin from official c_item id 1002 and c_flowerArt.cPrice multiplied by order num; load the account-isolated historical maximum across restarts with a minimum threshold of 3; confirmed insufficient recipe-flower stock or an inactive flower art takes priority and uses the official gs.orderCustomer.rejectOrder button regardless of reward ranking; all other orders at or above the historical maximum, or all orders with reward >= 3 when no maximum exists, may submit or make under existing stock/guard rules; lower rewards are temporary out of stock and are rejected through the same official button without making or submitting, and rejection does not update history; unknown reward, recipe/order data, tied rewards, or unavailable history fails closed; update history only after final completion";
const PALACE_ORDER_RULE = "submit palace order only while double gold has at least one minute left and the required flower stock is enough";

export function buildOrderStatusDocumentPayload(orderStatus, options = {}) {
  const now = options.now ?? new Date();
  const customerOrderActions = getAutoSubmitCustomerOrderActions(orderStatus?.customer);
  return {
    updatedAt: formatDateTime(now),
    runHistory: options.runHistory,
    mapping: { ...ORDER_STATUS_MAPPING },
    autoSubmitRule: AUTO_SUBMIT_RULE,
    customerOrderRule: CUSTOMER_ORDER_RULE,
    palaceOrderRule: PALACE_ORDER_RULE,
    pendingAutoSubmitActions: getAutoSubmitOrderActions(orderStatus),
    pendingCustomerOrderActions: customerOrderActions.map((action) => ({
      ...action,
      ...describeCustomerOrderAction(action),
    })),
    pendingPalaceOrderActions: getAutoSubmitPalaceOrderActions(orderStatus?.palace),
    ...orderStatus,
  };
}

export function writeOrderStatusDocument(orderStatus, options = {}) {
  const env = options.env || process.env;
  const fsModule = options.fsModule || fs;
  const writeArtifacts = options.writeStatusArtifacts;
  if (typeof writeArtifacts !== "function") {
    throw new TypeError("writeStatusArtifacts is required");
  }

  const outDir = env.STATUS_DOC_DIR || "outputs";
  fsModule.mkdirSync(outDir, { recursive: true });
  const jsonPath = env.ORDER_STATUS_JSON_PATH || `${outDir}/order-status.json`;
  const payload = buildOrderStatusDocumentPayload(orderStatus, options);
  const fingerprint = buildStatusArtifactFingerprint(payload);
  const [writeResult] = writeArtifacts([
    { path: jsonPath, content: `${JSON.stringify(payload, null, 2)}\n`, fingerprint },
  ]);
  const warn = options.warn || console.warn;
  const log = options.log || console.log;
  if (!writeResult.ok) {
    warn(JSON.stringify({
      step: "orderStatusDocumentWriteError",
      path: writeResult.path,
      attempts: writeResult.attempts,
      errorCode: writeResult.errorCode,
      message: writeResult.errorMessage,
    }));
  }
  log(JSON.stringify({ step: "orderStatusDocumentUpdated", jsonPath }));
  return { jsonPath, payload, writeResult };
}
