import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_PROFILE_SETTINGS } from "./system/profile-store.mjs";
import {
  PROFILE_SETTINGS_CANONICAL_KEYS,
  createDefaultTransactionId,
  createProfileSettingsTransactionState,
} from "./system/public/profile-settings-transaction-state.js";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";
const PARENT = "teamOrderTriggerProtectionEnabled";
const CHILD = "teamOrderPaidRenewProtectionEnabled";
const RESERVE = "pearlHireItemReserveCount";

function settings(patch = {}) {
  return { ...DEFAULT_PROFILE_SETTINGS, ...patch };
}

function snapshot({
  epoch = EPOCH_A,
  revision = 0,
  values = {},
  keyRevisions = {},
  protocolVersion = 2,
} = {}) {
  return {
    settingsProtocolVersion: protocolVersion,
    settings: settings(values),
    settingsEpoch: epoch,
    settingsRevision: revision,
    settingsKeyRevisions: Object.fromEntries(
      PROFILE_SETTINGS_CANONICAL_KEYS.map((key) => [key, keyRevisions[key] ?? 0]),
    ),
  };
}

function makeIds(...ids) {
  let index = 0;
  return () => ids[index++] ?? `tx-generated-${String(index).padStart(8, "0")}`;
}

function createState(ids = []) {
  return createProfileSettingsTransactionState({
    createTransactionId: makeIds(...ids),
    now: () => 1_000,
    settingsProtocolVersion: 2,
  });
}

function seed(state, profileId, input = {}) {
  const result = state.seedConfirmed(profileId, snapshot(input));
  assert.equal(result.applied, true);
}

test("canonical client keys stay aligned with the server settings contract", () => {
  assert.deepEqual(
    [...PROFILE_SETTINGS_CANONICAL_KEYS].sort(),
    Object.keys(DEFAULT_PROFILE_SETTINGS).sort(),
  );
});

test("settings transaction ID falls back when an older browser lacks crypto.randomUUID", () => {
  const id = createDefaultTransactionId({
    cryptoProvider: {},
    now: () => 1_723_456_789_000,
    random: () => 0.123456789,
  });
  assert.match(id, /^[A-Za-z0-9_-]{16,128}$/);
  assert.notEqual(id, "");
});

test("blocked profiles never invent defaults when no authoritative snapshot exists", () => {
  const state = createState();
  state.blockProfile("p1", "blocked-settings-state-invalid");

  assert.equal(state.getEffectiveSettings("p1"), null);
  assert.deepEqual(state.getProfileState("p1"), {
    profileId: "p1",
    confirmedSettings: null,
    settingsEpoch: null,
    settingsRevision: null,
    settingsKeyRevisions: null,
    authority: "unavailable",
    readState: "blocked-settings-state-invalid",
    blockState: "blocked-settings-state-invalid",
    inflightTransaction: null,
    queuedTransactions: [],
    reconcileState: null,
    busy: false,
  });
  assert.throws(
    () => state.enqueue("p1", { [PARENT]: false }),
    /blocked-settings-state-invalid|authoritative settings snapshot/i,
  );

  seed(state, "p1");
  assert.equal(state.getProfileState("p1").blockState, null);
  assert.equal(state.getProfileState("p1").authority, "authoritative");
});

test("transactions store partial intent metadata and overlay inflight plus ordered queue", () => {
  const state = createState([
    "tx-partial-00000001",
    "tx-partial-00000002",
    "tx-partial-00000003",
  ]);
  seed(state, "p1");
  seed(state, "p2");

  const first = state.enqueue("p1", { [CHILD]: false });
  const firstEffect = state.takeNextEffect("p1");
  const second = state.enqueue("p1", { [PARENT]: false });
  const other = state.enqueue("p2", { [RESERVE]: 77 });
  const otherEffect = state.takeNextEffect("p2");

  assert.deepEqual(first.originalPatch, { [CHILD]: false });
  assert.equal(Object.hasOwn(first, "previousSettings"), false);
  assert.deepEqual(first.predecessorTransactionIds, []);
  assert.deepEqual(second.predecessorTransactionIds, [first.transactionId]);
  assert.equal(second.createdSequence > first.createdSequence, true);
  assert.deepEqual(firstEffect.patch, { [CHILD]: false });
  assert.deepEqual(otherEffect.patch, { [RESERVE]: 77 });
  assert.notEqual(firstEffect.transactionId, other.transactionId);
  assert.equal(state.takeNextEffect("p1"), null);
  assert.equal(state.getEffectiveSettings("p1")[PARENT], false);
  assert.equal(state.getEffectiveSettings("p1")[CHILD], false);
  assert.equal(state.getProfileState("p1").queuedTransactions.length, 1);
  assert.equal(state.getProfileState("p2").inflightTransaction.transactionId, other.transactionId);
});

test("A/B/C success preserves later effective intent and serializes one profile", () => {
  const state = createState([
    "tx-abc-000000000001",
    "tx-abc-000000000002",
    "tx-abc-000000000003",
  ]);
  seed(state, "p1", { values: { [CHILD]: false, [PARENT]: true, [RESERVE]: 100 } });

  const a = state.enqueue("p1", { [CHILD]: true });
  state.takeNextEffect("p1");
  const b = state.enqueue("p1", { [PARENT]: false });
  state.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: a.transactionId,
    applied: true,
    snapshot: snapshot({
      revision: 1,
      values: { [CHILD]: true, [PARENT]: true },
      keyRevisions: { [CHILD]: 1 },
    }),
  });
  assert.equal(state.getEffectiveSettings("p1")[PARENT], false);
  assert.equal(state.getTransaction(a.transactionId).status, "committed");

  const bEffect = state.takeNextEffect("p1");
  assert.equal(bEffect.transactionId, b.transactionId);
  const c = state.enqueue("p1", { [RESERVE]: 77 });
  state.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: b.transactionId,
    applied: true,
    snapshot: snapshot({
      revision: 2,
      values: { [CHILD]: true, [PARENT]: false },
      keyRevisions: { [CHILD]: 1, [PARENT]: 2 },
    }),
  });
  assert.equal(state.getEffectiveSettings("p1")[RESERVE], 77);
  assert.equal(state.takeNextEffect("p1").transactionId, c.transactionId);
  state.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: c.transactionId,
    applied: true,
    snapshot: snapshot({
      revision: 3,
      values: { [CHILD]: true, [PARENT]: false, [RESERVE]: 77 },
      keyRevisions: { [CHILD]: 1, [PARENT]: 2, [RESERVE]: 3 },
    }),
  });
  assert.equal(state.getProfileState("p1").confirmedSettings[CHILD], true);
  assert.equal(state.getProfileState("p1").confirmedSettings[PARENT], false);
  assert.equal(state.getProfileState("p1").confirmedSettings[RESERVE], 77);
  assert.equal(state.getProfileState("p1").busy, false);
});

test("explicit failure removes only itself and rebases later local intent", () => {
  const state = createState([
    "tx-fail-0000000001",
    "tx-fail-0000000002",
    "tx-fail-0000000003",
  ]);
  seed(state, "p1", { values: { [RESERVE]: 1 } });

  const first = state.enqueue("p1", { [RESERVE]: 2 });
  state.takeNextEffect("p1");
  const second = state.enqueue("p1", { [RESERVE]: 3 });
  state.applyMutationResult({
    type: "explicit-failure",
    profileId: "p1",
    transactionId: first.transactionId,
  });

  assert.equal(state.getTransaction(first.transactionId).status, "explicit-failed");
  assert.equal(state.getEffectiveSettings("p1")[RESERVE], 3);
  const next = state.takeNextEffect("p1");
  assert.equal(next.transactionId, second.transactionId);
  assert.equal(next.sendBaseValues[RESERVE], 1);

  state.applyMutationResult({
    type: "explicit-failure",
    profileId: "p1",
    transactionId: second.transactionId,
  });
  const third = state.enqueue("p1", { [RESERVE]: 1 });
  assert.equal(state.takeNextEffect("p1"), null);
  assert.equal(state.getTransaction(third.transactionId).status, "satisfied");
});

test("same-key rapid reversal stays queued while its predecessor is pending", () => {
  const state = createState(["tx-reverse-0000001", "tx-reverse-0000002"]);
  seed(state, "p1", { values: { [PARENT]: false } });
  const first = state.enqueue("p1", { [PARENT]: true });
  state.takeNextEffect("p1");
  const second = state.enqueue("p1", { [PARENT]: false });

  assert.equal(state.getEffectiveSettings("p1")[PARENT], false);
  assert.equal(state.takeNextEffect("p1"), null);
  state.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: first.transactionId,
    applied: true,
    snapshot: snapshot({
      revision: 1,
      values: { [PARENT]: true },
      keyRevisions: { [PARENT]: 1 },
    }),
  });
  assert.equal(state.takeNextEffect("p1").transactionId, second.transactionId);
});

for (const [scenario, firstOutcome, secondOutcome, expectedValue] of [
  ["success-success", "success", "success", 3],
  ["fail-success", "failure", "success", 3],
  ["success-fail", "success", "failure", 2],
]) {
  test(`same-key ${scenario} preserves the last explicitly successful value`, () => {
    const state = createState([
      `tx-${scenario}-000000001`,
      `tx-${scenario}-000000002`,
    ]);
    seed(state, "p1", { values: { [RESERVE]: 1 } });
    const first = state.enqueue("p1", { [RESERVE]: 2 });
    state.takeNextEffect("p1");
    const second = state.enqueue("p1", { [RESERVE]: 3 });

    if (firstOutcome === "success") {
      state.applyMutationResult({
        type: "success",
        profileId: "p1",
        transactionId: first.transactionId,
        applied: true,
        snapshot: snapshot({
          revision: 1,
          values: { [RESERVE]: 2 },
          keyRevisions: { [RESERVE]: 1 },
        }),
      });
    } else {
      state.applyMutationResult({
        type: "explicit-failure",
        profileId: "p1",
        transactionId: first.transactionId,
      });
    }

    state.takeNextEffect("p1");
    if (secondOutcome === "success") {
      state.applyMutationResult({
        type: "success",
        profileId: "p1",
        transactionId: second.transactionId,
        applied: true,
        snapshot: snapshot({
          revision: firstOutcome === "success" ? 2 : 1,
          values: { [RESERVE]: 3 },
          keyRevisions: { [RESERVE]: firstOutcome === "success" ? 2 : 1 },
        }),
      });
    } else {
      state.applyMutationResult({
        type: "explicit-failure",
        profileId: "p1",
        transactionId: second.transactionId,
      });
    }

    assert.equal(state.getEffectiveSettings("p1")[RESERVE], expectedValue);
    assert.equal(state.getProfileState("p1").busy, false);
  });
}

test("refresh advances confirmed monotonically while replaying pending overlay", () => {
  const state = createState(["tx-refresh-0000001"]);
  seed(state, "p1", { revision: 2, values: { [PARENT]: true } });
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");

  state.applyRefresh("p1", snapshot({ revision: 3, values: { [PARENT]: true, [RESERVE]: 80 }, keyRevisions: { [RESERVE]: 3 } }));
  assert.equal(state.getProfileState("p1").settingsRevision, 3);
  assert.equal(state.getEffectiveSettings("p1")[PARENT], false);
  assert.equal(state.getEffectiveSettings("p1")[RESERVE], 80);

  state.applyRefresh("p1", snapshot({ revision: 1, values: { [PARENT]: false, [RESERVE]: 1 }, keyRevisions: { [PARENT]: 1 } }));
  assert.equal(state.getProfileState("p1").settingsRevision, 3);
  assert.equal(state.getProfileState("p1").inflightTransaction.transactionId, tx.transactionId);

  const mismatch = snapshot({ revision: 3, values: { [PARENT]: false, [RESERVE]: 80 }, keyRevisions: { [RESERVE]: 3 } });
  assert.equal(state.applyRefresh("p1", mismatch).classification, "same-revision-mismatch");
  assert.equal(state.getProfileState("p1").readState, "degraded");
  assert.equal(state.getProfileState("p1").confirmedSettings[PARENT], true);
});

test("an advanced snapshot with impossible key-revision evidence fails closed", () => {
  const state = createState(["tx-bad-key-revision1"]);
  seed(state, "p1", { values: { [RESERVE]: 1 } });
  const tx = state.enqueue("p1", { [RESERVE]: 3 });
  const result = state.applyRefresh("p1", snapshot({
    revision: 1,
    values: { [RESERVE]: 2 },
    keyRevisions: { [RESERVE]: 0 },
  }));

  assert.equal(result.classification, "key-revision-mismatch");
  assert.equal(state.getProfileState("p1").confirmedSettings[RESERVE], 1);
  assert.equal(state.getProfileState("p1").readState, "degraded");
  assert.equal(state.takeNextEffect("p1"), null);
  assert.equal(state.getTransaction(tx.transactionId).status, "queued");
});

test("known local predecessor can rebase but an external ABA key revision conflicts", () => {
  const local = createState(["tx-local-000000001", "tx-local-000000002"]);
  seed(local, "p1", { values: { [PARENT]: false } });
  const a = local.enqueue("p1", { [PARENT]: true });
  local.takeNextEffect("p1");
  const b = local.enqueue("p1", { [PARENT]: false });
  local.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: a.transactionId,
    applied: true,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: true }, keyRevisions: { [PARENT]: 1 } }),
  });
  assert.equal(local.takeNextEffect("p1").transactionId, b.transactionId);

  const external = createState(["tx-external-000001"]);
  seed(external, "p1", { values: { [PARENT]: false } });
  const tx = external.enqueue("p1", { [PARENT]: true });
  external.applyRefresh("p1", snapshot({
    revision: 2,
    values: { [PARENT]: false },
    keyRevisions: { [PARENT]: 2 },
  }));
  assert.equal(external.takeNextEffect("p1"), null);
  assert.equal(external.getTransaction(tx.transactionId).status, "conflict");
  assert.equal(external.getTransaction(tx.transactionId).reason, "external-change");
});

test("mutation and reconcile results require profile plus transaction correlation", () => {
  const state = createState(["tx-correlation-0001"]);
  seed(state, "p1");
  seed(state, "p2");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  const before = state.getProfileState("p1");

  assert.equal(state.applyMutationResult({ type: "explicit-failure", profileId: "p2", transactionId: tx.transactionId }).applied, false);
  assert.deepEqual(state.getProfileState("p1"), before);
  state.applyMutationResult({ type: "explicit-failure", profileId: "p1", transactionId: tx.transactionId });
  const ended = state.getProfileState("p1");
  assert.equal(state.applyMutationResult({ type: "success", profileId: "p1", transactionId: tx.transactionId, snapshot: snapshot({ revision: 1 }) }).applied, false);
  assert.equal(state.applyReconcileResult({ type: "success", profileId: "p1", transactionId: tx.transactionId, snapshot: snapshot({ revision: 1 }) }).applied, false);
  assert.deepEqual(state.getProfileState("p1"), ended);
});

test("a new authoritative epoch terminates every old-incarnation transaction", () => {
  const state = createState(["tx-epoch-000000001", "tx-epoch-000000002"]);
  seed(state, "p1");
  const first = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  const second = state.enqueue("p1", { [CHILD]: false });

  state.applyRefresh("p1", snapshot({ epoch: EPOCH_B, revision: 0 }));

  assert.equal(state.getTransaction(first.transactionId).status, "profile-recreated");
  assert.equal(state.getTransaction(second.transactionId).status, "profile-recreated");
  assert.equal(state.getTransaction(first.transactionId).isTerminal, true);
  assert.equal(state.getProfileState("p1").settingsEpoch, EPOCH_B);
  assert.equal(state.getProfileState("p1").busy, false);
});

for (const [name, current, expected] of [
  ["committed", { value: false, keyRevision: 3 }, "committed"],
  ["committed-superseded", { value: true, keyRevision: 3 }, "committed-superseded"],
  ["degraded", { value: true, keyRevision: 0 }, "confirming"],
]) {
  test(`an older success becomes ${name} without lowering confirmed`, () => {
    const state = createState([`tx-old-${name.replaceAll("-", "x")}-0001`]);
    seed(state, "p1", { values: { [PARENT]: true } });
    const tx = state.enqueue("p1", { [PARENT]: false });
    state.takeNextEffect("p1");
    state.applyRefresh("p1", snapshot({
      revision: 3,
      values: { [PARENT]: current.value, [RESERVE]: 88 },
      keyRevisions: { [PARENT]: current.keyRevision, [RESERVE]: 3 },
    }));
    state.applyMutationResult({
      type: "success",
      profileId: "p1",
      transactionId: tx.transactionId,
      applied: true,
      snapshot: snapshot({
        revision: 1,
        values: { [PARENT]: false },
        keyRevisions: { [PARENT]: 1 },
      }),
    });

    assert.equal(state.getProfileState("p1").settingsRevision, 3);
    assert.equal(state.getProfileState("p1").confirmedSettings[PARENT], current.value);
    assert.equal(state.getTransaction(tx.transactionId).status, expected);
  });
}

test("409 uses per-key three-way checks, shrinks residual, and bounds CAS rebase", () => {
  const state = createState(["tx-cas-00000000001"]);
  seed(state, "p1", { values: { [PARENT]: true, [CHILD]: true } });
  const tx = state.enqueue("p1", { [PARENT]: false, [CHILD]: false });
  state.takeNextEffect("p1");

  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({
      revision: 1,
      values: { [PARENT]: false, [CHILD]: true, [RESERVE]: 101 },
      keyRevisions: { [PARENT]: 1, [RESERVE]: 1 },
    }),
  });
  const residual = state.takeNextEffect("p1");
  assert.deepEqual(residual.patch, { [CHILD]: false });
  assert.equal(residual.transactionId, tx.transactionId);
  assert.equal(state.getTransaction(tx.transactionId).casRebaseCount, 1);

  for (let revision = 2; revision <= 3; revision += 1) {
    state.applyMutationResult({
      type: "conflict",
      profileId: "p1",
      transactionId: tx.transactionId,
      snapshot: snapshot({
        revision,
        values: { [PARENT]: false, [CHILD]: true, [RESERVE]: 100 + revision },
        keyRevisions: { [PARENT]: 1, [RESERVE]: revision },
      }),
    });
    assert.equal(state.takeNextEffect("p1").transactionId, tx.transactionId);
  }
  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({
      revision: 4,
      values: { [PARENT]: false, [CHILD]: true, [RESERVE]: 104 },
      keyRevisions: { [PARENT]: 1, [RESERVE]: 4 },
    }),
  });
  assert.equal(state.getTransaction(tx.transactionId).status, "conflict");
  assert.equal(state.getTransaction(tx.transactionId).reason, "contention");
  assert.equal(state.takeNextEffect("p1"), null);
});

test("a multi-key 409 with one changed key conflicts atomically", () => {
  const state = createState(["tx-atomic-000000001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false, [CHILD]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({
      revision: 1,
      values: { [PARENT]: true, [CHILD]: true },
      keyRevisions: { [PARENT]: 1 },
    }),
  });
  assert.equal(state.getTransaction(tx.transactionId).status, "conflict");
  assert.deepEqual(state.getTransaction(tx.transactionId).patch, { [PARENT]: false, [CHILD]: false });
});

test("a same-revision inconsistent 409 degrades instead of creating a retry effect", () => {
  const state = createState(["tx-conflict-mismatch1"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({ values: { [PARENT]: false } }),
  });
  assert.equal(state.getTransaction(tx.transactionId).status, "confirming");
  assert.equal(state.getTransaction(tx.transactionId).reason, "same-revision-mismatch");
  assert.equal(state.takeNextEffect("p1", { at: 1_000 }).type, "reconcile");
});

test("a valid GET after an inconsistent 409 performs a bounded CAS rebase", () => {
  const state = createState(["tx-bad-conflict-rebase1"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({ values: { [PARENT]: false } }),
  });
  const reconcile = state.takeNextEffect("p1", { at: 1_000 });
  state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    reconcileAttemptId: reconcile.reconcileAttemptId,
    snapshot: snapshot({ revision: 1, values: { [RESERVE]: 101 }, keyRevisions: { [RESERVE]: 1 } }),
  });
  const retry = state.takeNextEffect("p1");
  assert.equal(retry.transactionId, tx.transactionId);
  assert.equal(retry.settingsRevision, 1);
  assert.equal(state.getTransaction(tx.transactionId).casRebaseCount, 1);
  assert.equal(state.getTransaction(tx.transactionId).networkUnknownReplayUsed, false);
});

test("older 409 and reconcile snapshots never lower a newer confirmed base", () => {
  const conflict = createState(["tx-old-conflict-0001"]);
  seed(conflict, "p1", { revision: 1, values: { [RESERVE]: 100 } });
  const first = conflict.enqueue("p1", { [PARENT]: false });
  conflict.takeNextEffect("p1");
  conflict.applyRefresh("p1", snapshot({
    revision: 3,
    values: { [RESERVE]: 103 },
    keyRevisions: { [RESERVE]: 3 },
  }));
  conflict.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: first.transactionId,
    snapshot: snapshot({
      revision: 2,
      values: { [RESERVE]: 102 },
      keyRevisions: { [RESERVE]: 2 },
    }),
  });
  const rebased = conflict.takeNextEffect("p1");
  assert.equal(rebased.settingsRevision, 3);
  assert.equal(conflict.getProfileState("p1").settingsRevision, 3);

  const reconcile = createState(["tx-old-reconcile-01"]);
  seed(reconcile, "p1", { revision: 1 });
  const second = reconcile.enqueue("p1", { [PARENT]: false });
  reconcile.takeNextEffect("p1");
  reconcile.markNetworkUnknown("p1", second.transactionId);
  const oldGet = reconcile.takeNextEffect("p1", { at: 1_000 });
  reconcile.applyRefresh("p1", snapshot({
    revision: 3,
    values: { [PARENT]: false, [RESERVE]: 103 },
    keyRevisions: { [PARENT]: 3, [RESERVE]: 3 },
  }));
  reconcile.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: second.transactionId,
    reconcileAttemptId: oldGet.reconcileAttemptId,
    snapshot: snapshot({
      revision: 2,
      values: { [RESERVE]: 102 },
      keyRevisions: { [RESERVE]: 2 },
    }),
  });
  assert.equal(reconcile.takeNextEffect("p1"), null);
  assert.equal(reconcile.getTransaction(second.transactionId).status, "confirming");
  assert.equal(reconcile.getTransaction(second.transactionId).reason, "network-unknown");
  assert.equal(reconcile.getTransaction(second.transactionId).lastReconcileOutcome, "stale-snapshot");
  assert.equal(reconcile.getProfileState("p1").settingsRevision, 3);
  const freshGet = reconcile.takeNextEffect("p1", { at: 6_000 });
  reconcile.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: second.transactionId,
    reconcileAttemptId: freshGet.reconcileAttemptId,
    snapshot: snapshot({
      revision: 3,
      values: { [PARENT]: false, [RESERVE]: 103 },
      keyRevisions: { [PARENT]: 3, [RESERVE]: 3 },
    }),
  });
  assert.equal(reconcile.getTransaction(second.transactionId).status, "satisfied");
});

test("network unknown keeps overlay, blocks its queue, and permits one same-ID replay", () => {
  const state = createState(["tx-unknown-0000001", "tx-unknown-0000002"]);
  seed(state, "p1");
  const first = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  const second = state.enqueue("p1", { [CHILD]: false });
  state.markNetworkUnknown("p1", first.transactionId);

  assert.equal(state.getTransaction(first.transactionId).status, "confirming");
  assert.equal(state.getEffectiveSettings("p1")[PARENT], false);
  const reconcile = state.takeNextEffect("p1", { at: 1_000 });
  assert.deepEqual(reconcile, {
    type: "reconcile",
    profileId: "p1",
    transactionId: first.transactionId,
    attempt: 1,
    reconcileAttemptId: 1,
    manual: false,
    timeoutMs: 10_000,
  });
  assert.equal(state.takeNextEffect("p1", { at: 1_000 }), null);

  state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: first.transactionId,
    reconcileAttemptId: reconcile.reconcileAttemptId,
    snapshot: snapshot(),
    at: 1_500,
  });
  const replay = state.takeNextEffect("p1", { at: 1_500 });
  assert.equal(replay.type, "mutation");
  assert.equal(replay.transactionId, first.transactionId);
  assert.equal(state.getTransaction(first.transactionId).networkUnknownReplayUsed, true);

  state.markNetworkUnknown("p1", first.transactionId);
  const replayReconcile = state.takeNextEffect("p1", { at: 1_500 });
  state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: first.transactionId,
    reconcileAttemptId: replayReconcile.reconcileAttemptId,
    snapshot: snapshot(),
    at: 2_000,
  });
  assert.equal(state.getTransaction(first.transactionId).status, "confirming");
  assert.equal(state.getTransaction(first.transactionId).reason, "replay-result-unknown");
  assert.equal(state.takeNextEffect("p1", { at: 2_000 }), null);
  assert.equal(state.getProfileState("p1").queuedTransactions[0].transactionId, second.transactionId);
});

test("reconcile satisfaction and external ABA use snapshot key revisions", () => {
  const satisfied = createState(["tx-satisfied-000001"]);
  seed(satisfied, "p1");
  const a = satisfied.enqueue("p1", { [PARENT]: false });
  satisfied.takeNextEffect("p1");
  satisfied.markNetworkUnknown("p1", a.transactionId);
  const satisfiedGet = satisfied.takeNextEffect("p1", { at: 1_000 });
  satisfied.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: a.transactionId,
    reconcileAttemptId: satisfiedGet.reconcileAttemptId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: false }, keyRevisions: { [PARENT]: 1 } }),
  });
  assert.equal(satisfied.getTransaction(a.transactionId).status, "satisfied");

  const aba = createState(["tx-aba-00000000001"]);
  seed(aba, "p1");
  const b = aba.enqueue("p1", { [PARENT]: false });
  aba.takeNextEffect("p1");
  aba.markNetworkUnknown("p1", b.transactionId);
  const abaGet = aba.takeNextEffect("p1", { at: 1_000 });
  aba.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: b.transactionId,
    reconcileAttemptId: abaGet.reconcileAttemptId,
    snapshot: snapshot({ revision: 2, values: { [PARENT]: true }, keyRevisions: { [PARENT]: 2 } }),
  });
  assert.equal(aba.getTransaction(b.transactionId).status, "conflict");
  assert.equal(aba.getTransaction(b.transactionId).reason, "external-change");
});

test("automatic reconcile is bounded to immediate/5s/15s/60s and manual attempts debounce", () => {
  const state = createState(["tx-reconcile-000001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.markNetworkUnknown("p1", tx.transactionId, { at: 1_000 });

  const attempt1 = state.takeNextEffect("p1", { at: 1_000 });
  assert.equal(attempt1.attempt, 1);
  state.settleReconcileAttempt("p1", tx.transactionId, {
    at: 2_000,
    outcome: "timeout",
    reconcileAttemptId: attempt1.reconcileAttemptId,
  });
  assert.equal(state.getTransaction(tx.transactionId).nextReconcileAt, 7_000);
  assert.equal(state.takeNextEffect("p1", { at: 6_999 }), null);
  const attempt2 = state.takeNextEffect("p1", { at: 7_000 });
  assert.equal(attempt2.attempt, 2);
  state.settleReconcileAttempt("p1", tx.transactionId, {
    at: 8_000,
    outcome: "failure",
    reconcileAttemptId: attempt2.reconcileAttemptId,
  });
  assert.equal(state.getTransaction(tx.transactionId).nextReconcileAt, 23_000);
  const attempt3 = state.takeNextEffect("p1", { at: 23_000 });
  assert.equal(attempt3.attempt, 3);
  state.settleReconcileAttempt("p1", tx.transactionId, {
    at: 24_000,
    outcome: "degraded",
    reconcileAttemptId: attempt3.reconcileAttemptId,
  });
  assert.equal(state.getTransaction(tx.transactionId).nextReconcileAt, 84_000);
  const attempt4 = state.takeNextEffect("p1", { at: 84_000 });
  assert.equal(attempt4.attempt, 4);
  state.settleReconcileAttempt("p1", tx.transactionId, {
    at: 85_000,
    outcome: "timeout",
    reconcileAttemptId: attempt4.reconcileAttemptId,
  });
  assert.equal(state.getTransaction(tx.transactionId).nextReconcileAt, null);
  assert.equal(state.takeNextEffect("p1", { at: 999_999 }), null);

  const manual1 = state.takeNextEffect("p1", { at: 100_000, manualReconcile: true });
  assert.equal(manual1.manual, true);
  state.settleReconcileAttempt("p1", tx.transactionId, {
    at: 100_100,
    outcome: "failure",
    reconcileAttemptId: manual1.reconcileAttemptId,
  });
  assert.equal(state.takeNextEffect("p1", { at: 129_999, manualReconcile: true }), null);
  assert.equal(state.takeNextEffect("p1", { at: 130_000, manualReconcile: true }).manual, true);
  assert.equal(state.getTransaction(tx.transactionId).automaticReconcileAttemptCount, 4);
});

test("a late reconcile attempt cannot settle or replace the current attempt", () => {
  const state = createState(["tx-attempt-match-0001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.markNetworkUnknown("p1", tx.transactionId, { at: 1_000 });
  const first = state.takeNextEffect("p1", { at: 1_000 });
  state.settleReconcileAttempt("p1", tx.transactionId, {
    at: 2_000,
    outcome: "timeout",
    reconcileAttemptId: first.reconcileAttemptId,
  });
  const second = state.takeNextEffect("p1", { at: 7_000 });

  assert.equal(state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    reconcileAttemptId: first.reconcileAttemptId,
    snapshot: snapshot(),
  }).applied, false);
  assert.equal(state.getProfileState("p1").reconcileState.active, true);
  assert.equal(state.getProfileState("p1").reconcileState.activeAttemptId, second.reconcileAttemptId);
});

test("manual reconcile debounce survives a same-ID unknown safe replay", () => {
  const state = createState(["tx-manual-replay-0001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.markNetworkUnknown("p1", tx.transactionId, { at: 1_000 });
  const manual = state.takeNextEffect("p1", { at: 1_000, manualReconcile: true });
  state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    reconcileAttemptId: manual.reconcileAttemptId,
    snapshot: snapshot(),
    at: 1_100,
  });
  state.takeNextEffect("p1", { at: 1_200 });
  state.markNetworkUnknown("p1", tx.transactionId, { at: 2_000 });
  assert.equal(state.takeNextEffect("p1", { at: 2_000, manualReconcile: true }), null);
  assert.equal(state.takeNextEffect("p1", { at: 31_000, manualReconcile: true }).manual, true);
});

test("runtime degraded, authoritative missing, and blocked errors retain distinct states", () => {
  const committed = createState(["tx-degraded-commit01"]);
  seed(committed, "p1");
  const tx = committed.enqueue("p1", { [PARENT]: false });
  committed.takeNextEffect("p1");
  committed.applyMutationResult({
    type: "runtime-degraded",
    commitState: "profile-committed-runtime-degraded",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: false }, keyRevisions: { [PARENT]: 1 } }),
  });
  assert.equal(committed.getTransaction(tx.transactionId).status, "profile-committed-runtime-degraded");
  const committedGet = committed.takeNextEffect("p1", { at: 1_000 });
  committed.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    reconcileAttemptId: committedGet.reconcileAttemptId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: false }, keyRevisions: { [PARENT]: 1 } }),
  });
  assert.equal(committed.getTransaction(tx.transactionId).status, "committed");

  const blocked = createState(["tx-blocked-00000001"]);
  seed(blocked, "p1");
  const blockedTx = blocked.enqueue("p1", { [PARENT]: false });
  blocked.takeNextEffect("p1");
  blocked.applyMutationResult({
    type: "blocked-canonical-collision",
    profileId: "p1",
    transactionId: blockedTx.transactionId,
  });
  assert.equal(blocked.getProfileState("p1").authority, "stale");
  assert.equal(blocked.getTransaction(blockedTx.transactionId).status, "blocked-canonical-collision");
  assert.equal(blocked.takeNextEffect("p1"), null);

  const missing = createState(["tx-missing-000000001", "tx-missing-000000002"]);
  seed(missing, "p1");
  const first = missing.enqueue("p1", { [PARENT]: false });
  missing.takeNextEffect("p1");
  const queued = missing.enqueue("p1", { [CHILD]: false });
  missing.applyMutationResult({ type: "profile-missing", profileId: "p1", transactionId: first.transactionId });
  assert.equal(missing.getTransaction(first.transactionId).status, "profile-missing");
  assert.equal(missing.getTransaction(queued.transactionId).status, "profile-missing");
  assert.equal(missing.getProfileState("p1").busy, false);

  missing.seedConfirmed("p1", snapshot({ epoch: EPOCH_B }));
  assert.equal(missing.getProfileState("p1").blockState, null);
  assert.equal(missing.getProfileState("p1").settingsEpoch, EPOCH_B);
  assert.equal(missing.getProfileState("p1").busy, false);
});

for (const blockState of ["blocked-canonical-collision", "blocked-settings-state-invalid"]) {
  test(`${blockState} resumes a mutation proven not applied after a valid repair snapshot`, () => {
    const state = createState([`tx-repair-${blockState}-01`]);
    seed(state, "p1");
    const tx = state.enqueue("p1", { [PARENT]: false });
    state.takeNextEffect("p1");
    state.applyMutationResult({
      type: blockState,
      profileId: "p1",
      transactionId: tx.transactionId,
    });
    state.seedConfirmed("p1", snapshot());
    const retry = state.takeNextEffect("p1");
    assert.equal(retry.transactionId, tx.transactionId);
    assert.equal(state.getTransaction(tx.transactionId).networkUnknownReplayUsed, false);
    assert.equal(state.getProfileState("p1").blockState, null);
  });
}

test("a repaired read-side block preserves unknown provenance instead of assuming not-applied", () => {
  const state = createState(["tx-read-block-000001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.blockProfile("p1", "blocked-settings-state-invalid");
  state.seedConfirmed("p1", snapshot());
  assert.equal(state.getTransaction(tx.transactionId).status, "confirming");
  assert.equal(state.takeNextEffect("p1", { at: 1_000 }).type, "reconcile");
});

test("profile-missing only unblocks for a different authoritative epoch", () => {
  const state = createState(["tx-missing-epoch-0001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({ type: "profile-missing", profileId: "p1", transactionId: tx.transactionId });

  assert.equal(state.seedConfirmed("p1", snapshot({ revision: 1 })).classification, "profile-missing-stale-incarnation");
  assert.equal(state.getProfileState("p1").blockState, "profile-missing");
  state.seedConfirmed("p1", snapshot({ epoch: EPOCH_B }));
  assert.equal(state.getProfileState("p1").blockState, null);
  assert.equal(state.getTransaction(tx.transactionId).status, "profile-missing");
});

test("the public profile-missing block terminates inflight and queued transactions", () => {
  const state = createState(["tx-public-missing-001", "tx-public-missing-002"]);
  seed(state, "p1");
  const first = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  const second = state.enqueue("p1", { [CHILD]: false });
  state.blockProfile("p1", "profile-missing");
  assert.equal(state.getTransaction(first.transactionId).status, "profile-missing");
  assert.equal(state.getTransaction(second.transactionId).status, "profile-missing");
  assert.equal(state.getProfileState("p1").busy, false);
});

test("first authoritative import clears profile-missing when no prior epoch existed", () => {
  const state = createState(["tx-first-import-00001"]);
  state.blockProfile("p1", "profile-missing");
  assert.equal(state.getProfileState("p1").settingsEpoch, null);
  state.seedConfirmed("p1", snapshot());
  assert.equal(state.getProfileState("p1").blockState, null);
  assert.equal(state.enqueue("p1", { [PARENT]: false }).profileId, "p1");
});

test("known not-applied runtime repair uses normal rebase without consuming unknown replay", () => {
  const state = createState(["tx-runtime-repair-001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "runtime-degraded",
    commitState: "not-applied",
    profileId: "p1",
    transactionId: tx.transactionId,
  });
  const repair = state.takeNextEffect("p1", { at: 1_000 });
  state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    reconcileAttemptId: repair.reconcileAttemptId,
    snapshot: snapshot(),
  });
  const retry = state.takeNextEffect("p1");
  assert.equal(retry.transactionId, tx.transactionId);
  assert.equal(state.getTransaction(tx.transactionId).networkUnknownReplayUsed, false);
  assert.equal(state.getTransaction(tx.transactionId).casRebaseCount, 0);
});

test("a read-side runtime block preserves ready as known not applied", () => {
  const state = createState(["tx-ready-read-block-01"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "session-token-invalid",
    profileId: "p1",
    transactionId: tx.transactionId,
  });
  assert.equal(state.getTransaction(tx.transactionId).status, "ready");
  state.blockProfile("p1", "blocked-runtime-degraded");
  const repair = state.takeNextEffect("p1", { at: 1_000 });
  state.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    reconcileAttemptId: repair.reconcileAttemptId,
    snapshot: snapshot(),
  });
  const retry = state.takeNextEffect("p1");
  assert.equal(retry.transactionId, tx.transactionId);
  assert.equal(state.getTransaction(tx.transactionId).networkUnknownReplayUsed, false);
});

test("a synced committed snapshot clears a runtime block when no mutation is inflight", () => {
  const idle = createState();
  seed(idle, "p1");
  idle.blockProfile("p1", "blocked-runtime-degraded");
  idle.applyRefresh("p1", snapshot());
  assert.equal(idle.getProfileState("p1").blockState, null);

  const queued = createState(["tx-queued-runtime-block1"]);
  seed(queued, "p1");
  const tx = queued.enqueue("p1", { [PARENT]: false });
  queued.blockProfile("p1", "blocked-runtime-degraded");
  assert.equal(queued.takeNextEffect("p1"), null);
  queued.applyRefresh("p1", snapshot());
  assert.equal(queued.takeNextEffect("p1").transactionId, tx.transactionId);
});

test("degraded reconcile without a snapshot stays degraded and an old snapshot cannot confirm a committed revision", () => {
  const unknown = createState(["tx-get-degraded-0001"]);
  seed(unknown, "p1");
  const first = unknown.enqueue("p1", { [PARENT]: false });
  unknown.takeNextEffect("p1");
  unknown.markNetworkUnknown("p1", first.transactionId);
  const degradedGet = unknown.takeNextEffect("p1", { at: 1_000 });
  unknown.applyReconcileResult({
    type: "runtime-degraded",
    profileId: "p1",
    transactionId: first.transactionId,
    reconcileAttemptId: degradedGet.reconcileAttemptId,
    at: 2_000,
  });
  assert.equal(unknown.getTransaction(first.transactionId).status, "confirming");
  assert.equal(unknown.getTransaction(first.transactionId).nextReconcileAt, 7_000);
  assert.equal(unknown.getProfileState("p1").blockState, "blocked-runtime-degraded");
  assert.equal(unknown.getProfileState("p1").readState, "blocked-runtime-degraded");
  assert.equal(unknown.getProfileState("p1").authority, "stale");

  const committed = createState(["tx-old-committed-get1"]);
  seed(committed, "p1");
  const second = committed.enqueue("p1", { [PARENT]: false });
  committed.takeNextEffect("p1");
  committed.applyMutationResult({
    type: "runtime-degraded",
    commitState: "profile-committed-runtime-degraded",
    profileId: "p1",
    transactionId: second.transactionId,
    snapshot: snapshot({
      revision: 2,
      values: { [PARENT]: false },
      keyRevisions: { [PARENT]: 2 },
    }),
  });
  const oldCommittedGet = committed.takeNextEffect("p1", { at: 1_000 });
  committed.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: second.transactionId,
    reconcileAttemptId: oldCommittedGet.reconcileAttemptId,
    snapshot: snapshot({
      revision: 1,
      values: { [PARENT]: false },
      keyRevisions: { [PARENT]: 1 },
    }),
    at: 2_000,
  });
  assert.equal(committed.getTransaction(second.transactionId).status, "profile-committed-runtime-degraded");
  assert.equal(committed.getTransaction(second.transactionId).reason, "runtime-degraded");
  assert.equal(committed.getTransaction(second.transactionId).lastReconcileOutcome, "stale-snapshot");
  assert.equal(committed.getProfileState("p1").blockState, "blocked-runtime-degraded");
});

test("committed-degraded rejects inconsistent commit and supersede evidence", () => {
  const initialMismatch = createState(["tx-commit-mismatch-001"]);
  seed(initialMismatch, "p1");
  const first = initialMismatch.enqueue("p1", { [PARENT]: false });
  initialMismatch.takeNextEffect("p1");
  initialMismatch.applyMutationResult({
    type: "runtime-degraded",
    commitState: "profile-committed-runtime-degraded",
    profileId: "p1",
    transactionId: first.transactionId,
    snapshot: snapshot({ values: { [PARENT]: false } }),
  });
  assert.equal(initialMismatch.getTransaction(first.transactionId).status, "confirming");
  assert.equal(initialMismatch.getTransaction(first.transactionId).reason, "same-revision-mismatch");
  assert.equal(initialMismatch.getTransaction(first.transactionId).committedRevision, null);

  const badSupersede = createState(["tx-bad-supersede-001"]);
  seed(badSupersede, "p1");
  const second = badSupersede.enqueue("p1", { [PARENT]: false });
  badSupersede.takeNextEffect("p1");
  badSupersede.applyMutationResult({
    type: "runtime-degraded",
    commitState: "profile-committed-runtime-degraded",
    profileId: "p1",
    transactionId: second.transactionId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: false }, keyRevisions: { [PARENT]: 1 } }),
  });
  const get = badSupersede.takeNextEffect("p1", { at: 1_000 });
  badSupersede.applyReconcileResult({
    type: "success",
    profileId: "p1",
    transactionId: second.transactionId,
    reconcileAttemptId: get.reconcileAttemptId,
    snapshot: snapshot({ revision: 2, values: { [PARENT]: true }, keyRevisions: { [PARENT]: 1 } }),
  });
  assert.equal(badSupersede.getTransaction(second.transactionId).status, "confirming");
  assert.equal(badSupersede.getTransaction(second.transactionId).reason, "key-revision-mismatch");
  assert.equal(badSupersede.getTransaction(second.transactionId).committedRevision, 1);
  assert.equal(badSupersede.getProfileState("p1").blockState, "blocked-runtime-degraded");
});

test("same-revision mutation mismatch keeps the existing snapshot and confirms via reconcile", () => {
  const state = createState(["tx-same-revision-001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    applied: true,
    snapshot: snapshot({ values: { [PARENT]: false } }),
  });
  assert.equal(state.getTransaction(tx.transactionId).status, "confirming");
  assert.equal(state.getTransaction(tx.transactionId).reason, "same-revision-mismatch");
  assert.equal(state.getProfileState("p1").confirmedSettings[PARENT], true);
  assert.equal(state.takeNextEffect("p1", { at: 1_000 }).type, "reconcile");
});

test("protocol mismatch fails closed before mutation and incomplete success blocks the profile", () => {
  const state = createProfileSettingsTransactionState({
    createTransactionId: makeIds("tx-protocol-0000001"),
    now: () => 1_000,
  });
  seed(state, "p1");
  assert.equal(state.getProfileState("p1").blockState, "protocol-incompatible");
  assert.equal(state.getProfileState("p1").authority, "stale");
  assert.throws(() => state.enqueue("p1", { [PARENT]: false }), /protocol-incompatible/i);
  state.setProtocolVersion(2);
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "success",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: { settingsProtocolVersion: 2 },
  });
  assert.equal(state.getProfileState("p1").blockState, "protocol-incompatible");
  assert.equal(state.getTransaction(tx.transactionId).status, "protocol-incompatible");
});

test("a damaged refresh protocol block is not cleared by repeating the session handshake", () => {
  const state = createState(["tx-protocol-block-001"]);
  seed(state, "p1");
  state.applyRefresh("p1", { settingsProtocolVersion: 2 });
  assert.equal(state.getProfileState("p1").blockState, "protocol-incompatible");
  state.setProtocolVersion(2);
  assert.equal(state.getProfileState("p1").blockState, "protocol-incompatible");
  assert.throws(() => state.enqueue("p1", { [PARENT]: false }), /protocol-incompatible/i);
  state.seedConfirmed("p1", snapshot());
  assert.equal(state.getProfileState("p1").blockState, null);
});

test("protocol block prevents a confirming transaction from issuing reconcile effects", () => {
  const state = createState(["tx-protocol-reconcile1"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.markNetworkUnknown("p1", tx.transactionId);
  state.applyRefresh("p1", { settingsProtocolVersion: 1 });
  assert.equal(state.takeNextEffect("p1", { at: 1_000 }), null);
});

test("token/CAS retries reuse an ID while a confirmed reapply creates a new ID", () => {
  const state = createState([
    "tx-retry-0000000001",
    "tx-reapply-00000001",
  ]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  const first = state.takeNextEffect("p1");
  state.applyMutationResult({ type: "session-token-invalid", profileId: "p1", transactionId: tx.transactionId });
  const retried = state.takeNextEffect("p1");
  assert.equal(retried.transactionId, first.transactionId);
  assert.equal(state.getTransaction(tx.transactionId).sessionTokenRetryUsed, true);

  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: true }, keyRevisions: { [PARENT]: 1 } }),
  });
  const reapplied = state.resolve("p1", tx.transactionId, "reapply", { businessConfirmed: true });
  assert.equal(state.getTransaction(tx.transactionId).status, "terminated");
  assert.notEqual(reapplied.transactionId, tx.transactionId);
  assert.equal(reapplied.transactionId, "tx-reapply-00000001");
  assert.deepEqual(reapplied.predecessorTransactionIds, []);
  assert.equal(reapplied.intentBaseValues[PARENT], true);
});

test("adopt-current releases queued work and used IDs cannot be generated again", () => {
  const state = createState([
    "tx-adopt-000000001",
    "tx-after-0000000001",
    "tx-adopt-000000001",
  ]);
  seed(state, "p1");
  seed(state, "p2");
  const conflict = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  const queued = state.enqueue("p1", { [CHILD]: false });
  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: conflict.transactionId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: true }, keyRevisions: { [PARENT]: 1 } }),
  });
  state.resolve("p1", conflict.transactionId, "adopt-current");
  assert.equal(state.getTransaction(conflict.transactionId).status, "terminated");
  assert.equal(state.takeNextEffect("p1").transactionId, queued.transactionId);
  assert.throws(() => state.enqueue("p2", { [PARENT]: false }), /already been used/i);
});

test("failed reapply ID allocation leaves the original conflict untouched", () => {
  const duplicate = "tx-reapply-atomic-001";
  const state = createState([duplicate, duplicate]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "conflict",
    profileId: "p1",
    transactionId: tx.transactionId,
    snapshot: snapshot({ revision: 1, values: { [PARENT]: true }, keyRevisions: { [PARENT]: 1 } }),
  });
  assert.throws(
    () => state.resolve("p1", tx.transactionId, "reapply", { businessConfirmed: true }),
    /already been used/i,
  );
  assert.equal(state.getTransaction(tx.transactionId).status, "conflict");
  assert.equal(state.getProfileState("p1").busy, true);
});

test("rolled-back without a synced snapshot remains network unknown", () => {
  const state = createState(["tx-rollback-schema-001"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.applyMutationResult({
    type: "runtime-degraded",
    commitState: "rolled-back",
    profileId: "p1",
    transactionId: tx.transactionId,
  });
  assert.equal(state.getTransaction(tx.transactionId).status, "confirming");
  assert.equal(state.getTransaction(tx.transactionId).reason, "network-unknown");
});

test("invalid generated transaction IDs fail closed before entering a queue", () => {
  const state = createProfileSettingsTransactionState({
    createTransactionId: () => "short",
    now: () => 1_000,
    settingsProtocolVersion: 2,
  });
  seed(state, "p1");
  assert.throws(() => state.enqueue("p1", { [PARENT]: false }), /invalid transaction ID/i);
  assert.equal(state.getProfileState("p1").busy, false);
});

test("ordinary refresh cannot finish a confirming transaction", () => {
  const state = createState(["tx-refresh-unknown01"]);
  seed(state, "p1");
  const tx = state.enqueue("p1", { [PARENT]: false });
  state.takeNextEffect("p1");
  state.markNetworkUnknown("p1", tx.transactionId);
  state.applyRefresh("p1", snapshot({ revision: 1, values: { [PARENT]: false }, keyRevisions: { [PARENT]: 1 } }));
  assert.equal(state.getTransaction(tx.transactionId).status, "confirming");
  assert.equal(state.getProfileState("p1").busy, true);
});
