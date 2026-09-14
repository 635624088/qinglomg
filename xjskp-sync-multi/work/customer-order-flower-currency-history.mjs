import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_VERSION = 1;
export const MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD = 3;
export const CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_FILE_NAME = "customer-order-flower-currency-history.json";

const CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_STALE_MS = 60_000;
const CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_TIMEOUT_MS = 30_000;
const CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_RETRY_MS = 20;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeAccountId(accountId) {
  const value = String(accountId ?? "").trim();
  return value || null;
}

function emptyHistory(filePath, sourceStatus, damageReason = null) {
  return {
    version: CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_VERSION,
    accounts: {},
    filePath,
    sourceStatus,
    damageReason,
    damaged: sourceStatus === "damaged",
  };
}

export function resolveCustomerOrderFlowerCurrencyHistoryPath(options = {}) {
  if (options.historyPath) return path.resolve(String(options.historyPath));
  const statusDir = options.statusDir || process.env.STATUS_DOC_DIR || null;
  if (statusDir) {
    return path.join(path.resolve(String(statusDir)), CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_FILE_NAME);
  }
  return path.resolve("outputs", CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_FILE_NAME);
}

export function loadCustomerOrderFlowerCurrencyHistory(historyPath) {
  const filePath = path.resolve(String(historyPath));
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return emptyHistory(filePath, "missing");
    return emptyHistory(filePath, "damaged", error?.message || "read-failed");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return emptyHistory(filePath, "damaged", error?.message || "invalid-json");
  }
  if (
    !isRecord(parsed)
    || parsed.version !== CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_VERSION
    || !isRecord(parsed.accounts)
  ) {
    return emptyHistory(filePath, "damaged", "invalid-schema");
  }
  return {
    ...parsed,
    filePath,
    sourceStatus: "loaded",
    damageReason: null,
    damaged: false,
  };
}

export function getAccountCustomerOrderFlowerCurrencyHistory(history, accountId) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    return {
      available: false,
      accountId: null,
      historicalMaxReward: null,
      minimumReward: MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD,
      threshold: null,
      recordStatus: "account-id-missing",
      sourceStatus: history?.sourceStatus || "unavailable",
      historyPath: history?.filePath || null,
    };
  }

  const accountRecord = history?.accounts?.[normalizedAccountId];
  const historicalMaxReward = accountRecord?.historicalMaxReward;
  const validRecord = isPositiveSafeInteger(historicalMaxReward)
    && historicalMaxReward >= MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD;
  const recordStatus = !accountRecord
    ? "missing-account"
    : validRecord
      ? "recorded"
      : "invalid-record";
  return {
    available: true,
    accountId: normalizedAccountId,
    historicalMaxReward: validRecord ? historicalMaxReward : null,
    minimumReward: MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD,
    threshold: validRecord
      ? Math.max(MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD, historicalMaxReward)
      : MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD,
    recordStatus,
    sourceStatus: history?.sourceStatus || "missing",
    historyPath: history?.filePath || null,
    damaged: history?.damaged === true,
  };
}

function recordCompletedReward(history, { accountId, reward, completed, settlementStatus, now } = {}) {
  const normalizedAccountId = normalizeAccountId(accountId);
  if (!normalizedAccountId) {
    return { history, updated: false, reason: "account-id-missing", historicalMaxReward: null };
  }
  if (completed !== true || settlementStatus !== "completed") {
    return { history, updated: false, reason: "not-finalized", historicalMaxReward: null };
  }
  if (!isPositiveSafeInteger(reward)) {
    return { history, updated: false, reason: "reward-unknown", historicalMaxReward: null };
  }
  if (reward < MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD) {
    return {
      history,
      updated: false,
      reason: "below-minimum-threshold",
      historicalMaxReward: null,
    };
  }

  const accounts = isRecord(history?.accounts) ? { ...history.accounts } : {};
  const previousRecord = accounts[normalizedAccountId];
  const previousMax = isPositiveSafeInteger(previousRecord?.historicalMaxReward)
    && previousRecord.historicalMaxReward >= MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD
    ? previousRecord.historicalMaxReward
    : null;
  if (previousMax != null && reward <= previousMax) {
    return {
      history,
      updated: false,
      reason: "not-new-high",
      historicalMaxReward: previousMax,
    };
  }

  const updatedAt = (now instanceof Date ? now : new Date(now || Date.now())).toISOString();
  const historicalMaxReward = Math.max(MIN_CUSTOMER_ORDER_FLOWER_CURRENCY_REWARD, reward);
  accounts[normalizedAccountId] = {
    ...(isRecord(previousRecord) ? previousRecord : {}),
    accountId: normalizedAccountId,
    historicalMaxReward,
    lastCompletedReward: reward,
    updatedAt,
  };
  return {
    history: {
      version: CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_VERSION,
      accounts,
      filePath: history.filePath,
      sourceStatus: "loaded",
      damageReason: null,
      damaged: false,
    },
    updated: true,
    reason: "new-high-completed",
    historicalMaxReward,
  };
}

async function saveCustomerOrderFlowerCurrencyHistory(historyPath, history) {
  const filePath = path.resolve(String(historyPath));
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const payload = JSON.stringify({
    version: CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_VERSION,
    accounts: history.accounts || {},
  }, null, 2) + "\n";
  try {
    await fsp.writeFile(temporaryPath, payload, "utf8");
    await fsp.rename(temporaryPath, filePath);
  } finally {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function acquireCustomerOrderFlowerCurrencyHistoryLock(historyPath) {
  const filePath = path.resolve(String(historyPath));
  const lockPath = `${filePath}.lock`;
  const ownerId = `${process.pid}-${crypto.randomUUID()}`;
  const deadline = Date.now() + CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_TIMEOUT_MS;
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    let handle = null;
    try {
      handle = await fsp.open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify({
        version: 1,
        ownerId,
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      }, null, 2)}\n`, "utf8");
      await handle.close();
      handle = null;

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await fsp.readFile(lockPath, "utf8"));
            if (current?.ownerId === ownerId) await fsp.rm(lockPath, { force: true });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      if (await recoverCustomerOrderFlowerCurrencyHistoryLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw Object.assign(
          new Error(`timed out waiting for customer-order history lock: ${lockPath}`),
          { code: "CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_TIMEOUT" },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_RETRY_MS));
    }
  }
}

async function recoverCustomerOrderFlowerCurrencyHistoryLock(lockPath) {
  let record = null;
  let stat = null;
  try {
    record = JSON.parse(await fsp.readFile(lockPath, "utf8"));
    stat = await fsp.stat(lockPath);
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    try {
      stat = await fsp.stat(lockPath);
    } catch (statError) {
      if (statError?.code === "ENOENT") return true;
    }
  }

  const ownerPid = Number(record?.ownerPid);
  if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
    if (isProcessAlive(ownerPid)) return false;
    await fsp.rm(lockPath, { force: true });
    return true;
  }
  if (stat && Date.now() - stat.mtimeMs >= CUSTOMER_ORDER_FLOWER_CURRENCY_HISTORY_LOCK_STALE_MS) {
    await fsp.rm(lockPath, { force: true });
    return true;
  }
  return false;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function updateCustomerOrderFlowerCurrencyHistory(options = {}) {
  const historyPath = resolveCustomerOrderFlowerCurrencyHistoryPath(options);
  const lock = await acquireCustomerOrderFlowerCurrencyHistoryLock(historyPath);
  try {
    const history = loadCustomerOrderFlowerCurrencyHistory(historyPath);
    const result = recordCompletedReward(history, options);
    if (result.updated) await saveCustomerOrderFlowerCurrencyHistory(historyPath, result.history);
    const persisted = result.updated
      ? loadCustomerOrderFlowerCurrencyHistory(historyPath)
      : history;
    const account = getAccountCustomerOrderFlowerCurrencyHistory(persisted, options.accountId);
    return {
      ...result,
      history: persisted,
      filePath: historyPath,
      account,
      historicalMaxReward: result.updated
        ? account.historicalMaxReward
        : result.historicalMaxReward ?? account.historicalMaxReward,
    };
  } finally {
    await lock.release();
  }
}
