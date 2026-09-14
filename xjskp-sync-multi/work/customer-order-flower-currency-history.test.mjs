import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getAccountCustomerOrderFlowerCurrencyHistory,
  loadCustomerOrderFlowerCurrencyHistory,
  updateCustomerOrderFlowerCurrencyHistory,
} from "./customer-order-flower-currency-history.mjs";

test("customer-order history uses the minimum threshold of 3 and survives a restart", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-history-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const historyPath = path.join(rootDir, "customer-order-history.json");

  const missing = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  const missingAccount = getAccountCustomerOrderFlowerCurrencyHistory(missing, "account-a");
  assert.equal(missingAccount.threshold, 3);
  assert.equal(missingAccount.historicalMaxReward, null);
  assert.equal(missingAccount.recordStatus, "missing-account");

  const lowReward = await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "account-a",
    reward: 2,
    completed: true,
    settlementStatus: "completed",
  });
  assert.equal(lowReward.updated, false);
  assert.equal(lowReward.reason, "below-minimum-threshold");

  const newHigh = await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "account-a",
    reward: 4,
    completed: true,
    settlementStatus: "completed",
  });
  assert.equal(newHigh.updated, true);
  assert.equal(newHigh.historicalMaxReward, 4);

  const restarted = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  const restartedAccount = getAccountCustomerOrderFlowerCurrencyHistory(restarted, "account-a");
  assert.equal(restartedAccount.threshold, 4);
  assert.equal(restartedAccount.historicalMaxReward, 4);
  assert.equal(restartedAccount.recordStatus, "recorded");
});

test("customer-order history does not update for craft-only or failed actions", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-history-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const historyPath = path.join(rootDir, "customer-order-history.json");

  const crafted = await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "account-a",
    reward: 8,
    completed: false,
    settlementStatus: "crafted",
  });
  assert.equal(crafted.updated, false);
  assert.equal(crafted.reason, "not-finalized");

  const failed = await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "account-a",
    reward: 8,
    completed: false,
    settlementStatus: "failed",
  });
  assert.equal(failed.updated, false);
  assert.equal(failed.reason, "not-finalized");

  await assert.rejects(fsp.access(historyPath));
});

test("customer-order history is isolated by account and can be read by another process", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-history-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const historyPath = path.join(rootDir, "customer-order-history.json");

  await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "account-a",
    reward: 7,
    completed: true,
    settlementStatus: "completed",
  });
  await updateCustomerOrderFlowerCurrencyHistory({
    historyPath,
    accountId: "account-b",
    reward: 4,
    completed: true,
    settlementStatus: "completed",
  });

  const reloaded = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  assert.equal(getAccountCustomerOrderFlowerCurrencyHistory(reloaded, "account-a").threshold, 7);
  assert.equal(getAccountCustomerOrderFlowerCurrencyHistory(reloaded, "account-b").threshold, 4);
  assert.equal(getAccountCustomerOrderFlowerCurrencyHistory(reloaded, "account-c").threshold, 3);
});

test("concurrent account updates preserve one atomic history snapshot", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-history-concurrent-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const historyPath = path.join(rootDir, "customer-order-history.json");

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) => updateCustomerOrderFlowerCurrencyHistory({
      historyPath,
      accountId: `account-${index}`,
      reward: 3 + index,
      completed: true,
      settlementStatus: "completed",
    })),
  );
  assert.equal(results.every((result) => result.updated), true);

  const reloaded = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  assert.equal(reloaded.sourceStatus, "loaded");
  assert.equal(reloaded.damaged, false);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(reloaded.accounts).map(([accountId, record]) => [accountId, record.historicalMaxReward]),
    ),
    Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`account-${index}`, 3 + index])),
  );
  assert.deepEqual(
    (await fsp.readdir(rootDir)).sort(),
    ["customer-order-history.json"],
  );
});

test("customer-order history fails closed at 3 for corrupt or invalid records", async (t) => {
  const rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "xjskp-customer-history-"));
  t.after(() => fsp.rm(rootDir, { recursive: true, force: true }));
  const historyPath = path.join(rootDir, "customer-order-history.json");

  await fsp.writeFile(historyPath, "{not-json", "utf8");
  const damaged = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  const damagedAccount = getAccountCustomerOrderFlowerCurrencyHistory(damaged, "account-a");
  assert.equal(damaged.sourceStatus, "damaged");
  assert.equal(damagedAccount.threshold, 3);
  assert.equal(damagedAccount.historicalMaxReward, null);

  await fsp.writeFile(historyPath, JSON.stringify({
    version: 1,
    accounts: { "account-a": { historicalMaxReward: 1 } },
  }), "utf8");
  const invalid = loadCustomerOrderFlowerCurrencyHistory(historyPath);
  const invalidAccount = getAccountCustomerOrderFlowerCurrencyHistory(invalid, "account-a");
  assert.equal(invalidAccount.threshold, 3);
  assert.equal(invalidAccount.recordStatus, "invalid-record");
  assert.equal(invalidAccount.historicalMaxReward, null);
});
