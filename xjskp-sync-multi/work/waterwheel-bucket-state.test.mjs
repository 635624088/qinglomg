import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  consumeWaterwheelBucket,
  createWaterwheelBucketState,
  readAndAdvanceWaterwheelBucketState,
  saveWaterwheelBucketState,
} from "./waterwheel-bucket-state.mjs";

function config({ bucketCreateCd = 10, bucketExistMax = 3, bucketGetMax = 20 } = {}) {
  return { bucketCreateCd, bucketExistMax, bucketGetMax };
}

function sync({ count = 0, uid = null } = {}) {
  return {
    $usrTot: { data: { ...(uid == null ? {} : { id: uid }) } },
    waterwheel: { count, advList: [] },
  };
}

function withTempState(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waterwheel-bucket-state-unit-"));
  try {
    return callback(path.join(dir, "account-a.json"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function read(pathname, options = {}) {
  return readAndAdvanceWaterwheelBucketState(sync(options), {
    profileId: "account-a",
    bucketStatePath: pathname,
    config: config(),
    nowMs: 0,
    ...options,
  });
}

test("does not generate before the configured interval and generates one bucket at due time", () => {
  withTempState((statePath) => {
    assert.equal(read(statePath).storedBucketCount, 0);
    assert.equal(readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 9_999,
    }).storedBucketCount, 0);
    const due = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
    });
    assert.equal(due.storedBucketCount, 1);
    assert.equal(due.generatedBucketCount, 1);
    assert.equal(due.state.nextGenerationAtMs, 20_000);
  });
});

test("long elapsed time fills the configured local storage cap and then stops", () => {
  withTempState((statePath) => {
    const state = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config({ bucketExistMax: 3 }),
      nowMs: 0,
    });
    assert.equal(state.storedBucketCount, 0);
    const full = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config({ bucketExistMax: 3 }),
      nowMs: 100_000,
    });
    assert.equal(full.storedBucketCount, 3);
    assert.equal(full.generatedBucketCount, 3);
    assert.equal(full.storageCapacity, 3);
    assert.equal(full.state.nextGenerationAtMs, null);

    const stillFull = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config({ bucketExistMax: 3 }),
      nowMs: 200_000,
    });
    assert.equal(stillFull.storedBucketCount, 3);
    assert.equal(stillFull.generatedBucketCount, 0);
  });
});

test("claimed count dynamically reduces the generation capacity", () => {
  withTempState((statePath) => {
    readAndAdvanceWaterwheelBucketState(sync({ count: 4 }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config({ bucketExistMax: 4, bucketGetMax: 5 }),
      nowMs: 0,
    });
    const due = readAndAdvanceWaterwheelBucketState(sync({ count: 4 }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config({ bucketExistMax: 4, bucketGetMax: 5 }),
      nowMs: 10_000,
    });
    assert.equal(due.storedBucketCount, 1);
    assert.equal(due.storageCapacity, 1);

    const quotaExhausted = readAndAdvanceWaterwheelBucketState(sync({ count: 5 }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config({ bucketExistMax: 4, bucketGetMax: 5 }),
      nowMs: 20_000,
    });
    assert.equal(quotaExhausted.storedBucketCount, 0);
    assert.equal(quotaExhausted.storageCapacity, 0);
  });
});

test("restart loads the account state and continues from its persisted generation time", () => {
  withTempState((statePath) => {
    readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 0,
    });
    const first = readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
    });
    assert.equal(first.storedBucketCount, 1);

    const afterRestart = readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 15_000,
    });
    assert.equal(afterRestart.persistenceStatus, "loaded");
    assert.equal(afterRestart.storedBucketCount, 1);
    assert.equal(afterRestart.state.nextGenerationAtMs, 20_000);
  });
});

test("corrupt or identity-mismatched state falls back without fabricating stored buckets", () => {
  withTempState((statePath) => {
    fs.writeFileSync(statePath, "not-json", "utf8");
    const corrupt = readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 0,
    });
    assert.equal(corrupt.storedBucketCount, 0);
    assert.equal(corrupt.invalidReason, "state-read-or-parse-failed");

    const otherProfile = readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-b",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 0,
    });
    assert.equal(otherProfile.storedBucketCount, 0);
    assert.equal(otherProfile.invalidReason, "state-validation-failed");

    const identityStatePath = path.join(path.dirname(statePath), "identity.json");
    readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      bucketStatePath: identityStatePath,
      config: config(),
      nowMs: 0,
    });
    readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      bucketStatePath: identityStatePath,
      config: config(),
      nowMs: 10_000,
    });
    const otherAccount = readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-b" }), {
      profileId: "account-a",
      bucketStatePath: identityStatePath,
      config: config(),
      nowMs: 10_000,
    });
    assert.equal(otherAccount.storedBucketCount, 0);
    assert.equal(otherAccount.invalidReason, "state-validation-failed");
  });
});

test("write failure never exposes a newly generated bucket before it is persisted", () => {
  withTempState((statePath) => {
    readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 0,
    });
    const failingFileSystem = {
      ...fs,
      renameSync() {
        throw new Error("rename failed");
      },
    };
    const failed = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
      fileSystem: failingFileSystem,
    });
    assert.equal(failed.storedBucketCount, 0);
    assert.equal(failed.generatedBucketCount, 0);
    assert.equal(failed.persistenceStatus, "write-failed");

    const retry = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
    });
    assert.equal(retry.storedBucketCount, 1);
    assert.equal(retry.generatedBucketCount, 1);
  });
});

test("successful consumption persists one-bucket decrement and does not repeat it", () => {
  withTempState((statePath) => {
    readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 0,
    });
    readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
    });
    const consumed = consumeWaterwheelBucket(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
    });
    assert.equal(consumed.consumed, true);
    assert.equal(consumed.persisted, true);
    assert.equal(consumed.storedBucketCount, 0);
    assert.equal(consumed.state.nextGenerationAtMs, 20_000);

    const after = readAndAdvanceWaterwheelBucketState(sync(), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: config(),
      nowMs: 10_000,
    });
    assert.equal(after.storedBucketCount, 0);
    assert.equal(after.generatedBucketCount, 0);
  });
});

test("consumption keeps an already scheduled next generation time", () => {
  withTempState((statePath) => {
    const bucketConfig = config({ bucketCreateCd: 10, bucketExistMax: 3, bucketGetMax: 20 });
    const state = {
      ...createWaterwheelBucketState({
        profileId: "account-a",
        accountUid: "uid-a",
        nowMs: 0,
        config: bucketConfig,
      }),
      storedBucketCount: 1,
      nextGenerationAtMs: 10_000,
    };
    saveWaterwheelBucketState({ statePath, state });

    const consumed = consumeWaterwheelBucket(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      accountUid: "uid-a",
      bucketStatePath: statePath,
      config: bucketConfig,
      nowMs: 5_000,
    });

    assert.equal(consumed.consumed, true);
    assert.equal(consumed.storedBucketCount, 0);
    assert.equal(consumed.state.nextGenerationAtMs, 10_000);
    assert.equal(readAndAdvanceWaterwheelBucketState(sync({ uid: "uid-a" }), {
      profileId: "account-a",
      accountUid: "uid-a",
      bucketStatePath: statePath,
      config: bucketConfig,
      nowMs: 5_000,
    }).state.nextGenerationAtMs, 10_000);
  });
});

test("consuming the final daily-quota bucket leaves no stored bucket or next bucket", () => {
  withTempState((statePath) => {
    const bucketConfig = config({ bucketCreateCd: 30, bucketExistMax: 8, bucketGetMax: 60 });
    const state = {
      ...createWaterwheelBucketState({
        profileId: "account-a",
        nowMs: 0,
        config: bucketConfig,
      }),
      storedBucketCount: 1,
      nextGenerationAtMs: null,
    };
    saveWaterwheelBucketState({ statePath, state });

    const consumed = consumeWaterwheelBucket(sync({ count: 59 }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: bucketConfig,
      nowMs: 0,
    });

    assert.equal(consumed.consumed, true);
    assert.equal(consumed.storedBucketCount, 0);
    const afterFinalClaim = readAndAdvanceWaterwheelBucketState(sync({ count: 60 }), {
      profileId: "account-a",
      bucketStatePath: statePath,
      config: bucketConfig,
      nowMs: 0,
    });
    assert.equal(afterFinalClaim.claimedBucketCount, 60);
    assert.equal(afterFinalClaim.remainingDailyBucketCount, 0);
    assert.equal(afterFinalClaim.storageCapacity, 0);
    assert.equal(afterFinalClaim.storedBucketCount, 0);
    assert.equal(afterFinalClaim.state.nextGenerationAtMs, null);
  });
});


