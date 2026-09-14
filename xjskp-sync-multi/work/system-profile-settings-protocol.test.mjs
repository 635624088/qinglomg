import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_PROFILE_SETTINGS } from "./system/profile-store.mjs";
import {
  PROFILE_SETTINGS_CANONICAL_KEYS as CLIENT_PROFILE_SETTINGS_CANONICAL_KEYS,
} from "./system/public/profile-settings-transaction-state.js";
import {
  PROFILE_SETTINGS_CANONICAL_KEYS,
  PROFILE_SETTINGS_PROTOCOL_VERSION,
  buildProfileSettingsServiceResult,
  canonicalizeProfileSettingsPatch,
  isValidProfileSettingsTransactionId,
  parseProfileSettingsIfMatch,
} from "./system/profile-settings-protocol.mjs";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const TRANSACTION_ID = "txn_1234567890abcdef";

function snapshot(overrides = {}) {
  return {
    settings: { ...DEFAULT_PROFILE_SETTINGS },
    settingsEpoch: EPOCH,
    settingsRevision: 3,
    settingsKeyRevisions: Object.fromEntries(
      Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, 3]),
    ),
    ...overrides,
  };
}

test("protocol canonical keys stay aligned with the legacy settings contract", () => {
  assert.equal(PROFILE_SETTINGS_PROTOCOL_VERSION, 2);
  assert.deepEqual(PROFILE_SETTINGS_CANONICAL_KEYS, Object.keys(DEFAULT_PROFILE_SETTINGS));
  assert.deepEqual(PROFILE_SETTINGS_CANONICAL_KEYS, CLIENT_PROFILE_SETTINGS_CANONICAL_KEYS);
  assert.equal(
    PROFILE_SETTINGS_CANONICAL_KEYS.length,
    Object.keys(DEFAULT_PROFILE_SETTINGS).length,
  );
});

test("partial patch canonicalization honors the canonical ordinary-order key", () => {
  assert.deepEqual(
    canonicalizeProfileSettingsPatch({
      autoSubmitOrdinaryResidentOrders: true,
      autoSubmitOrdinaryResidentOrdersForLevelUp: false,
      pearlHireItemReserveCount: 77,
    }),
    {
      autoSubmitOrdinaryResidentOrdersForLevelUp: false,
      pearlHireItemReserveCount: 77,
    },
  );
  assert.deepEqual(
    canonicalizeProfileSettingsPatch({ autoSubmitOrdinaryResidentOrders: true }),
    { autoSubmitOrdinaryResidentOrdersForLevelUp: true },
  );
});

test("partial patch validation is non-empty, flat, all-or-nothing, and fail closed", () => {
  for (const patch of [
    {},
    [],
    { unknownSetting: true },
    { pearlHireItemReserveCount: -1 },
    { teamOrderTriggerProtectionEnabled: { value: true } },
    { autoSubmitCyclicStoryOrders: true, pearlHireItemReserveCount: -1 },
  ]) {
    assert.throws(
      () => canonicalizeProfileSettingsPatch(patch),
      (error) => error?.code === "INVALID_PROFILE_SETTINGS",
    );
  }
});

test("If-Match parser accepts only a strong epoch and safe revision ETag", () => {
  assert.deepEqual(parseProfileSettingsIfMatch(`"${EPOCH}:0"`), {
    settingsEpoch: EPOCH,
    settingsRevision: 0,
  });
  assert.deepEqual(parseProfileSettingsIfMatch(`"${EPOCH}:9007199254740991"`), {
    settingsEpoch: EPOCH,
    settingsRevision: Number.MAX_SAFE_INTEGER,
  });
  for (const value of [
    `${EPOCH}:0`,
    `W/"${EPOCH}:0"`,
    `"${EPOCH}:-1"`,
    `"${EPOCH}:01"`,
    `"${EPOCH}:9007199254740992"`,
    '"not-an-epoch:0"',
  ]) {
    assert.equal(parseProfileSettingsIfMatch(value), null);
  }
});

test("transaction IDs use the frozen ASCII length and character contract", () => {
  assert.equal(isValidProfileSettingsTransactionId(TRANSACTION_ID), true);
  assert.equal(isValidProfileSettingsTransactionId("a".repeat(16)), true);
  assert.equal(isValidProfileSettingsTransactionId("a".repeat(128)), true);
  for (const value of ["a".repeat(15), "a".repeat(129), "space is invalid!", "中文事务编号", null]) {
    assert.equal(isValidProfileSettingsTransactionId(value), false);
  }
});

test("service response builder keeps committed and conflict snapshots complete", () => {
  const committed = buildProfileSettingsServiceResult("committed", {
    snapshot: snapshot(),
    transactionId: TRANSACTION_ID,
    profile: { id: "p1", label: "P1", secrets: { CTOKEN: "never" } },
  });
  assert.equal(committed.statusCode, 200);
  assert.equal(committed.body.settingsProtocolVersion, 2);
  assert.equal(committed.body.applied, true);
  assert.equal(committed.body.commitState, "committed");
  assert.equal(committed.body.runtimeSyncStatus, "synced");
  assert.equal(committed.body.transactionId, TRANSACTION_ID);
  assert.equal(committed.body.profile.secrets, undefined);
  assert.deepEqual(committed.body.settingsKeyRevisions, snapshot().settingsKeyRevisions);

  const conflict = buildProfileSettingsServiceResult("conflict", {
    snapshot: snapshot(),
    transactionId: TRANSACTION_ID,
    reason: "profile-recreated",
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.error, "PROFILE_SETTINGS_CONFLICT");
  assert.equal(conflict.body.commitState, "not-applied");
  assert.equal(conflict.body.reason, "profile-recreated");
  assert.equal(conflict.body.settingsEpoch, EPOCH);
});

test("service response builder never invents snapshots for unknown or invalid state", () => {
  const unknown = buildProfileSettingsServiceResult("runtime-degraded", {
    transactionId: TRANSACTION_ID,
    commitState: "unknown",
  });
  assert.equal(unknown.statusCode, 503);
  assert.equal(unknown.body.commitState, "unknown");
  assert.equal(Object.hasOwn(unknown.body, "settings"), false);
  assert.equal(Object.hasOwn(unknown.body, "settingsEpoch"), false);

  const invalid = buildProfileSettingsServiceResult("state-invalid", {
    transactionId: TRANSACTION_ID,
    error: "PROFILE_SETTINGS_REVISION_INVALID",
  });
  assert.equal(invalid.statusCode, 503);
  assert.equal(invalid.body.runtimeSyncStatus, "degraded");
  assert.equal(Object.hasOwn(invalid.body, "settings"), false);

  const collision = buildProfileSettingsServiceResult("collision", {
    transactionId: TRANSACTION_ID,
    collisionSources: ["alias-a", "alias-b"],
  });
  assert.equal(collision.statusCode, 409);
  assert.equal(collision.body.error, "PROFILE_ID_CANONICAL_COLLISION");
  assert.equal(Object.hasOwn(collision.body, "settings"), false);
});

test("service response builder rejects incomplete or contradictory snapshots", () => {
  const wrongKeys = Object.fromEntries(
    Array.from(
      { length: PROFILE_SETTINGS_CANONICAL_KEYS.length },
      (_, index) => [`wrong-${index}`, 99],
    ),
  );
  for (const invalidSnapshot of [
    snapshot({ settings: {} }),
    snapshot({ settingsKeyRevisions: wrongKeys }),
    snapshot({ settingsKeyRevisions: { ...keyRevisionFixture(), pearlHireItemReserveCount: 4 } }),
  ]) {
    assert.throws(
      () => buildProfileSettingsServiceResult("committed", {
        snapshot: invalidSnapshot,
        transactionId: TRANSACTION_ID,
      }),
      /complete profile settings snapshot/,
    );
  }
});

test("mutation result builders require a valid transaction ID", () => {
  for (const [kind, options] of [
    ["committed", { snapshot: snapshot() }],
    ["no-op", { snapshot: snapshot() }],
    ["invalid-settings", {}],
    ["missing", {}],
    ["conflict", { snapshot: snapshot() }],
    ["rolled-back", { snapshot: snapshot() }],
    ["runtime-degraded", { commitState: "unknown" }],
  ]) {
    assert.throws(
      () => buildProfileSettingsServiceResult(kind, options),
      /valid transaction ID/,
    );
  }
  assert.deepEqual(buildProfileSettingsServiceResult("read-missing"), {
    statusCode: 404,
    body: { error: "PROFILE_NOT_FOUND" },
  });
});

test("precondition and missing responses preserve their distinct schemas", () => {
  const precondition = buildProfileSettingsServiceResult("precondition", {
    transactionId: TRANSACTION_ID,
  });
  assert.deepEqual(precondition, {
    statusCode: 428,
    body: {
      error: "PROFILE_SETTINGS_PRECONDITION_REQUIRED",
      settingsProtocolVersion: 2,
      transactionId: TRANSACTION_ID,
      commitState: "not-applied",
      requiredPrecondition: "If-Match + X-XJSKP-Settings-Transaction-Id",
      message: "Refresh the page and use a matching settings protocol version",
    },
  });

  const missing = buildProfileSettingsServiceResult("missing", {
    transactionId: TRANSACTION_ID,
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.body, {
    error: "PROFILE_NOT_FOUND",
    transactionId: TRANSACTION_ID,
    commitState: "not-applied",
  });
});

function keyRevisionFixture() {
  return Object.fromEntries(
    Object.keys(DEFAULT_PROFILE_SETTINGS).map((key) => [key, 3]),
  );
}
