import assert from "node:assert/strict";
import test from "node:test";

import {
  PROFILE_SETTINGS_CANONICAL_KEYS,
} from "./system/public/profile-settings-transaction-state.js";
import { createProfileSettingsClient } from "./system/public/profile-settings-client.js";

const EPOCH_A = "00000000-0000-4000-8000-0000000000a1";
const PARENT = "autoReceiveWaterwheelBuckets";
const CHILD = "skipWaterwheelVideoBuckets";

function settings(overrides = {}) {
  return Object.fromEntries(PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [
    key,
    Object.hasOwn(overrides, key) ? overrides[key] : defaultValue(key),
  ]));
}

function defaultValue(key) {
  if (key === "experienceGuardThresholdPercent") return 0.5;
  if (key === "flowerRackTargetArtId") return null;
  if (key === "materialShopRefreshWindowStart") return "23:50";
  if (key === "materialShopRefreshMaxCostYuanbao") return 4;
  if (key === "pearlHireItemReserveCount") return 100;
  if (key === "teamOrderGuardMultiplier") return 2;
  if (key === "customerOrderFlowerCurrencyRewardReleaseMask") return 4;
  if (key === PARENT) return true;
  return false;
}

function snapshot({ revision = 0, values = {}, keyRevisions = {} } = {}) {
  return {
    settingsProtocolVersion: 2,
    settings: settings(values),
    settingsEpoch: EPOCH_A,
    settingsRevision: revision,
    settingsKeyRevisions: Object.fromEntries(PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [
      key,
      Object.hasOwn(keyRevisions, key) ? keyRevisions[key] : 0,
    ])),
  };
}

function profilesResponse(profileId = "p1", input = {}) {
  const committed = snapshot(input);
  return {
    settingsProtocolVersion: 2,
    profiles: [{ id: profileId, label: profileId, runtimeSyncStatus: "synced", ...committed }],
  };
}

function success(effect, input = {}) {
  const committed = snapshot(input);
  return {
    status: 200,
    data: {
      ...committed,
      transactionId: effect.transactionId,
      applied: true,
      commitState: "committed",
      runtimeSyncStatus: "synced",
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function turn() {
  await new Promise((resolve) => setImmediate(resolve));
}

test("client keeps a rapid customer reward mask update based on the optimistic effective value", async () => {
  const held = deferred();
  const calls = [];
  const client = createProfileSettingsClient({
    createTransactionId: (() => {
      let index = 0;
      return () => `tx-customer-mask-${String(++index).padStart(4, "0")}`;
    })(),
    sendMutation: async (effect) => {
      calls.push(effect);
      if (calls.length === 1) return await held.promise;
      return success(effect, {
        revision: 2,
        values: { customerOrderFlowerCurrencyRewardReleaseMask: 7 },
        keyRevisions: { customerOrderFlowerCurrencyRewardReleaseMask: 2 },
      });
    },
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());

  const pump = client.pump("p1");
  client.enqueue("p1", { customerOrderFlowerCurrencyRewardReleaseMask: 5 });
  await turn();
  client.enqueue("p1", { customerOrderFlowerCurrencyRewardReleaseMask: 7 });
  assert.equal(
    client.getEffectiveSettings("p1").customerOrderFlowerCurrencyRewardReleaseMask,
    7,
  );
  held.resolve(success(calls[0], {
    revision: 1,
    values: { customerOrderFlowerCurrencyRewardReleaseMask: 5 },
    keyRevisions: { customerOrderFlowerCurrencyRewardReleaseMask: 1 },
  }));
  await pump;
  await client.pump("p1");
  assert.equal(calls[1].patch.customerOrderFlowerCurrencyRewardReleaseMask, 7);
});

test("client sends only the patch with strong CAS and keeps the optimistic overlay", async () => {
  const held = deferred();
  const calls = [];
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-client-partial-0001",
    sendMutation: async (effect) => {
      calls.push(effect);
      return await held.promise;
    },
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  const projected = client.applyProfilesResponse(profilesResponse());
  assert.equal(projected[0].settings[PARENT], true);

  const transaction = client.enqueue("p1", { [PARENT]: false });
  await turn();
  assert.equal(client.getEffectiveSettings("p1")[PARENT], false);
  assert.deepEqual(calls[0].patch, { [PARENT]: false });
  assert.equal(calls[0].ifMatch, `"${EPOCH_A}:0"`);
  assert.equal(calls[0].transactionId, transaction.transactionId);

  held.resolve(success(calls[0], {
    revision: 1,
    values: { [PARENT]: false },
    keyRevisions: { [PARENT]: 1 },
  }));
  await client.pump("p1");
  assert.equal(client.getTransaction(transaction.transactionId).status, "committed");
});

test("client refresh advances confirmed state without erasing a pending patch", async () => {
  const held = deferred();
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-refresh-overlay-001",
    sendMutation: async () => await held.promise,
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const tx = client.enqueue("p1", { [PARENT]: false });
  await turn();

  const projected = client.applyProfilesResponse(profilesResponse("p1", {
    revision: 1,
    values: { [CHILD]: true },
    keyRevisions: { [CHILD]: 1 },
  }));
  assert.equal(projected[0].settings[PARENT], false);
  assert.equal(projected[0].settings[CHILD], true);
  assert.equal(client.getProfileState("p1").inflightTransaction.transactionId, tx.transactionId);

  held.resolve(success(client.getProfileState("p1").inflightTransaction, {
    revision: 2,
    values: { [PARENT]: false, [CHILD]: true },
    keyRevisions: { [PARENT]: 2, [CHILD]: 1 },
  }));
  await client.pump("p1");
});

test("session token retry is accounted by the transaction and reuses its ID once", async () => {
  const calls = [];
  let refreshCount = 0;
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-session-retry-0001",
    refreshSession: async () => { refreshCount += 1; },
    sendMutation: async (effect) => {
      calls.push(effect);
      if (calls.length === 1) {
        return { status: 403, data: { error: "LOCAL_SESSION_TOKEN_INVALID" } };
      }
      return success(effect, {
        revision: 1,
        values: { [PARENT]: false },
        keyRevisions: { [PARENT]: 1 },
      });
    },
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const tx = client.enqueue("p1", { [PARENT]: false });
  await client.pump("p1");

  assert.equal(refreshCount, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].transactionId, calls[1].transactionId);
  assert.equal(client.getTransaction(tx.transactionId).sessionTokenRetryUsed, true);
});

test("a mismatched transaction ID cannot apply an otherwise valid success snapshot", async () => {
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-correlation-check01",
    sendMutation: async (effect) => ({
      ...success(effect, {
        revision: 1,
        values: { [PARENT]: false },
        keyRevisions: { [PARENT]: 1 },
      }),
      data: {
        ...success(effect, {
          revision: 1,
          values: { [PARENT]: false },
          keyRevisions: { [PARENT]: 1 },
        }).data,
        transactionId: "tx-wrong-correlation1",
      },
    }),
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const tx = client.enqueue("p1", { [PARENT]: false });
  await client.pump("p1");

  assert.equal(client.getTransaction(tx.transactionId).status, "protocol-incompatible");
  assert.equal(client.getProfileState("p1").settingsRevision, 0);
});

test("a mismatched transaction ID on invalid settings cannot explicitly fail the current transaction", async () => {
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-invalid-correlation01",
    sendMutation: async () => ({
      status: 400,
      data: {
        error: "INVALID_PROFILE_SETTINGS",
        transactionId: "tx-invalid-correlation02",
        commitState: "not-applied",
      },
    }),
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const tx = client.enqueue("p1", { [PARENT]: false });
  await client.pump("p1");

  assert.equal(client.getTransaction(tx.transactionId).status, "protocol-incompatible");
  assert.equal(client.getProfileState("p1").settingsRevision, 0);
});

test("missing session protocol fails closed before transport", () => {
  let mutationCalls = 0;
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-protocol-gate-0001",
    sendMutation: async () => { mutationCalls += 1; },
    sendReconcile: async () => {},
  });
  client.applyProfilesResponse(profilesResponse());
  assert.throws(
    () => client.enqueue("p1", { [PARENT]: false }),
    /protocol-incompatible/,
  );
  assert.equal(mutationCalls, 0);
});

test("a collision item is isolated from healthy profile hydration", () => {
  const client = createProfileSettingsClient({
    sendMutation: async () => assert.fail("mutation is not expected"),
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  const healthy = profilesResponse("p1").profiles[0];
  const projected = client.applyProfilesResponse({
    settingsProtocolVersion: 2,
    profiles: [
      healthy,
      { id: "p2", label: "p2", settingsStateError: "PROFILE_ID_CANONICAL_COLLISION" },
    ],
  });

  assert.equal(projected[0].settings[PARENT], true);
  assert.equal(projected[1].settings, null);
  assert.equal(client.getProfileState("p1").authority, "authoritative");
  assert.equal(client.getProfileState("p2").blockState, "blocked-canonical-collision");
});

test("network-unknown immediately reconciles and never rolls back the overlay", async () => {
  const reconcileCalls = [];
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-network-unknown-01",
    sendMutation: async () => { throw new Error("connection lost"); },
    sendReconcile: async (effect) => {
      reconcileCalls.push(effect);
      return { status: 200, data: snapshot({
        revision: 1,
        values: { [PARENT]: false },
        keyRevisions: { [PARENT]: 1 },
      }) };
    },
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const tx = client.enqueue("p1", { [PARENT]: false });
  await client.pump("p1");

  assert.equal(reconcileCalls.length, 1);
  assert.equal(client.getEffectiveSettings("p1")[PARENT], false);
  assert.equal(client.getTransaction(tx.transactionId).status, "satisfied");
});

test("conflict reapply executes business confirmation and allocates a new transaction ID", async () => {
  const ids = ["tx-conflict-original1", "tx-conflict-reapply01"];
  const calls = [];
  let confirms = 0;
  const client = createProfileSettingsClient({
    createTransactionId: () => ids.shift(),
    sendMutation: async (effect) => {
      calls.push(effect);
      if (calls.length === 1) {
        return {
          status: 409,
          data: {
            ...snapshot({
              revision: 1,
              values: { [PARENT]: true },
              keyRevisions: { [PARENT]: 1 },
            }),
            error: "PROFILE_SETTINGS_CONFLICT",
            transactionId: effect.transactionId,
            commitState: "not-applied",
            runtimeSyncStatus: "synced",
          },
        };
      }
      return success(effect, {
        revision: 2,
        values: { [PARENT]: false },
        keyRevisions: { [PARENT]: 2 },
      });
    },
    sendReconcile: async () => assert.fail("reconcile is not expected"),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const original = client.enqueue("p1", { [PARENT]: false }, {
    reconfirm: async () => { confirms += 1; return true; },
  });
  await client.pump("p1");
  assert.equal(client.getTransaction(original.transactionId).status, "conflict");

  const reapplied = await client.resolve("p1", original.transactionId, "reapply");
  await client.pump("p1");
  assert.equal(confirms, 1);
  assert.notEqual(reapplied.transactionId, original.transactionId);
  assert.equal(client.getTransaction(reapplied.transactionId).status, "committed");
});

test("reconcile timeout settles only the client attempt and preserves confirming state", async () => {
  const timers = [];
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-reconcile-timeout01",
    now: () => 1_000,
    setTimeoutFn(callback, delay) {
      timers.push({ callback, delay });
      queueMicrotask(callback);
      return timers.length;
    },
    clearTimeoutFn() {},
    sendMutation: async () => { throw new Error("connection lost"); },
    sendReconcile: async () => await new Promise(() => {}),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  const tx = client.enqueue("p1", { [PARENT]: false });
  await client.pump("p1");

  assert.equal(timers[0].delay, 10_000);
  assert.equal(client.getTransaction(tx.transactionId).status, "confirming");
  assert.equal(client.getTransaction(tx.transactionId).automaticReconcileAttemptCount, 1);
  assert.equal(client.getTransaction(tx.transactionId).nextReconcileAt, 6_000);
});

test("automatic reconcile owns independent 5s 15s 60s wake timers and dispose clears them", async () => {
  let clock = 1_000;
  let nextTimerId = 0;
  const wakeTimers = new Map();
  const wakeDelays = [];
  const clearedWakeTimers = [];
  const requestTimeoutDelays = [];
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-reconcile-wakeup-01",
    now: () => clock,
    scheduleWakeFn(callback, delay) {
      const id = ++nextTimerId;
      wakeTimers.set(id, callback);
      wakeDelays.push(delay);
      return id;
    },
    clearWakeFn(id) {
      clearedWakeTimers.push(id);
      wakeTimers.delete(id);
    },
    setTimeoutFn(callback, delay) {
      requestTimeoutDelays.push(delay);
      return { callback, delay };
    },
    clearTimeoutFn() {},
    sendMutation: async () => { throw new Error("connection lost"); },
    sendReconcile: async () => { throw new Error("reconcile failed"); },
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  client.enqueue("p1", { [PARENT]: false });
  await client.pump("p1");

  async function fireOnlyWake(at) {
    clock = at;
    const [[id, callback]] = wakeTimers;
    wakeTimers.delete(id);
    await callback();
  }

  assert.deepEqual(wakeDelays, [5_000]);
  await fireOnlyWake(6_000);
  assert.deepEqual(wakeDelays, [5_000, 15_000]);
  await fireOnlyWake(21_000);
  assert.deepEqual(wakeDelays, [5_000, 15_000, 60_000]);
  assert.deepEqual(requestTimeoutDelays, [10_000, 10_000, 10_000]);

  client.dispose();
  assert.equal(wakeTimers.size, 0);
  assert.equal(clearedWakeTimers.length, 1);
});

test("dispose clears and aborts an active independent 10s reconcile timeout", async () => {
  const timeoutHandles = [];
  const clearedTimeouts = [];
  let reconcileStarted = false;
  let reconcileAborted = false;
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-dispose-reconcile01",
    setTimeoutFn(callback, delay) {
      const handle = { callback, delay };
      timeoutHandles.push(handle);
      return handle;
    },
    clearTimeoutFn(handle) {
      clearedTimeouts.push(handle);
    },
    sendMutation: async () => { throw new Error("connection lost"); },
    sendReconcile: async (_effect, { signal }) => await new Promise((_resolve, reject) => {
      reconcileStarted = true;
      signal.addEventListener("abort", () => {
        reconcileAborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  client.enqueue("p1", { [PARENT]: false });
  await turn();

  assert.equal(reconcileStarted, true);
  assert.equal(timeoutHandles[0].delay, 10_000);
  client.dispose();
  await client.pump("p1");
  assert.equal(reconcileAborted, true);
  assert.ok(clearedTimeouts.includes(timeoutHandles[0]));
});

test("change events force only transaction patch keys while ordinary refresh has no forced keys", async () => {
  const changes = [];
  const held = deferred();
  const client = createProfileSettingsClient({
    createTransactionId: () => "tx-change-patch-keys01",
    sendMutation: async () => await held.promise,
    sendReconcile: async () => assert.fail("reconcile is not expected"),
    onChange: (change) => changes.push(change),
  });
  client.setSessionProtocolVersion(2);
  client.applyProfilesResponse(profilesResponse());
  assert.deepEqual(changes.at(-1).changedKeys, []);

  client.enqueue("p1", { [PARENT]: false });
  assert.deepEqual(changes.at(-1).changedKeys, [PARENT]);

  client.applyProfilesResponse(profilesResponse("p1", {
    revision: 1,
    values: { [CHILD]: true },
    keyRevisions: { [CHILD]: 1 },
  }));
  assert.deepEqual(changes.at(-1).changedKeys, []);

  held.resolve(success(client.getProfileState("p1").inflightTransaction, {
    revision: 2,
    values: { [PARENT]: false, [CHILD]: true },
    keyRevisions: { [PARENT]: 2, [CHILD]: 1 },
  }));
  await client.pump("p1");
});
