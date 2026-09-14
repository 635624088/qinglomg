import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_WATERWHEEL_THRESHOLD,
  WATERWHEEL_IFACES,
  getWaterwheelReceiveSyncState,
  isWaterwheelDeltaOutOfExpectedRange,
  getAutoWaterwheelActions,
  summarizeWaterwheelStatus,
} from "./waterwheel-state.mjs";
import { createWaterwheelBucketState } from "./waterwheel-bucket-state.mjs";
import { mergeGameSync } from "./garden-state.mjs";

function sync({ water = 9, count = 0, advList = [] } = {}) {
  return {
    $usrTot: {
      data: {
        bag: { 7: water },
      },
    },
    waterwheel: {
      count,
      advList,
    },
  };
}

const BUCKET_CONFIG = {
  bucketCreateCd: 30,
  bucketExistMax: 2,
  bucketGetMax: 10,
  bucketWaterRangeText: "3-7",
  bucketWaterMin: 3,
  bucketWaterMax: 7,
};

const STATUS_BUCKET_CONFIG = {
  ...BUCKET_CONFIG,
  bucketExistMax: 8,
  bucketGetMax: 60,
};

function generatedBucketState(config = STATUS_BUCKET_CONFIG, storedBucketCount = 1) {
  return {
    ...createWaterwheelBucketState({ profileId: "default", nowMs: 0, config }),
    storedBucketCount,
    nextGenerationAtMs: null,
  };
}

function withBucketStatePath(callback) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "waterwheel-bucket-state-"));
  const bucketStatePath = path.join(tempDir, "account-a.json");
  try {
    return callback(bucketStatePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("summarizes next waterwheel bucket as non-video and creates recv action below threshold", () => {
  const status = summarizeWaterwheelStatus(sync({ water: 15, count: 2, advList: [4] }), {
    config: STATUS_BUCKET_CONFIG,
    bucketState: generatedBucketState(),
  });

  assert.equal(status.threshold, DEFAULT_WATERWHEEL_THRESHOLD);
  assert.equal(status.exists, true);
  assert.equal(status.waterDropCount, 15);
  assert.equal(status.claimedBucketCount, 2);
  assert.equal(status.remainingBucketCount, 58);
  assert.equal(status.nextBucketNo, 3);
  assert.equal(status.nextBucketIsVideo, false);
  assert.equal(status.canReceive, true);
  assert.deepEqual(getAutoWaterwheelActions(status), [
    {
      type: "recvWaterwheelBucket",
      iface: WATERWHEEL_IFACES.recv,
      args: {},
      nextBucketNo: 3,
    },
  ]);
});

test("does not touch video bucket below threshold", () => {
  const status = summarizeWaterwheelStatus(sync({ water: 8, count: 2, advList: [3] }), {
    config: STATUS_BUCKET_CONFIG,
    bucketState: generatedBucketState(),
  });

  assert.equal(status.nextBucketNo, 3);
  assert.equal(status.nextBucketIsVideo, true);
  assert.equal(status.canReceive, false);
  assert.equal(status.reason, "next-bucket-video-retained");
  assert.equal(status.reasonText, "下一桶是视频桶，保留不领取");
  assert.deepEqual(getAutoWaterwheelActions(status), []);
});

test("models official skip then recv compound action for a video bucket when enabled", () => {
  const status = summarizeWaterwheelStatus(sync({ water: 8, count: 2, advList: [3] }), {
    config: STATUS_BUCKET_CONFIG,
    bucketState: generatedBucketState(),
    skipVideoBuckets: true,
  });

  assert.equal(WATERWHEEL_IFACES.skip, "gs.waterwheel.skip");
  assert.equal(status.nextBucketNo, 3);
  assert.equal(status.nextBucketIsVideo, true);
  assert.equal(status.canReceive, true);
  assert.equal(status.reason, "ready-video-base");
  assert.equal(status.reasonText, "可跳过视频并领取当前桶基础水滴");
  assert.deepEqual(getAutoWaterwheelActions(status), [
    {
      type: "receiveWaterwheelVideoBucketBase",
      nextBucketNo: 3,
      steps: [
        {
          stage: "skip-video-requirement",
          iface: WATERWHEEL_IFACES.skip,
          args: {},
        },
        {
          stage: "receive-base-reward",
          iface: WATERWHEEL_IFACES.recv,
          args: {},
        },
      ],
    },
  ]);
});

test("disables all waterwheel receive actions without hiding resource state", () => {
  const status = summarizeWaterwheelStatus(sync({ water: 8, count: 2, advList: [3] }), {
    autoReceiveEnabled: false,
    config: STATUS_BUCKET_CONFIG,
    bucketState: generatedBucketState(),
    skipVideoBuckets: true,
  });

  assert.equal(status.autoReceiveEnabled, false);
  assert.equal(status.configuredSkipVideoBucketsEnabled, true);
  assert.equal(status.skipVideoBucketsEnabled, false);
  assert.equal(status.waterDropCount, 8);
  assert.equal(status.remainingBucketCount, 58);
  assert.equal(status.nextBucketNo, 3);
  assert.equal(status.nextBucketIsVideo, true);
  assert.equal(status.reason, "profile-setting-disabled");
  assert.deepEqual(getAutoWaterwheelActions(status), []);
});

test("does not receive waterwheel bucket when water drop is at threshold", () => {
  const status = summarizeWaterwheelStatus(sync({ water: 16, count: 2, advList: [] }), {
    config: { bucketGetMax: 60 },
  });

  assert.equal(status.waterDropLow, false);
  assert.equal(status.canReceive, false);
  assert.equal(status.reason, "water-drop-not-low");
  assert.deepEqual(getAutoWaterwheelActions(status), []);
});

test("mergeGameSync preserves and updates waterwheel state", () => {
  const merged = mergeGameSync(
    sync({ water: 9, count: 2, advList: [3, 7] }),
    { waterwheel: { count: 3 } },
  );

  assert.deepEqual(merged.waterwheel, {
    count: 3,
    advList: [3, 7],
  });
});

test("detects pending water sync when bucket advances before water drop updates", () => {
  assert.equal(
    getWaterwheelReceiveSyncState(
      { waterDropCount: 0, claimedBucketCount: 27, remainingBucketCount: 33 },
      { waterDropCount: 0, claimedBucketCount: 28, remainingBucketCount: 32 },
    ),
    "pending-water-sync",
  );
});

test("detects synced waterwheel receive when water drop count increases", () => {
  assert.equal(
    getWaterwheelReceiveSyncState(
      { waterDropCount: 0, claimedBucketCount: 27, remainingBucketCount: 33 },
      { waterDropCount: 7, claimedBucketCount: 28, remainingBucketCount: 32 },
    ),
    "synced",
  );
});

test("treats over-range waterwheel server snapshot delta as synced with a diagnostic flag", () => {
  const beforeStatus = {
    waterDropCount: 15,
    claimedBucketCount: 0,
    remainingBucketCount: 60,
    bucketWaterMax: 7,
  };
  const afterStatus = {
    waterDropCount: 29,
    claimedBucketCount: 1,
    remainingBucketCount: 59,
    bucketWaterMax: 7,
  };

  assert.equal(getWaterwheelReceiveSyncState(beforeStatus, afterStatus), "synced");
  assert.equal(isWaterwheelDeltaOutOfExpectedRange(beforeStatus, afterStatus), true);
});

test("summarizes minimum normal bucket reward for conservative water credit", () => {
  const status = summarizeWaterwheelStatus(sync({ water: 8, count: 2, advList: [] }), {
    config: {
      bucketGetMax: 60,
      bucketWaterMin: 3,
      bucketWaterMax: 7,
      bucketWaterRangeText: "3-7",
    },
  });

  assert.equal(status.bucketWaterMin, 3);
  assert.equal(status.bucketWaterMax, 7);
  assert.equal(status.bucketWaterRangeText, "3-7");
});

test("regression: disabled receiving does not accumulate locally generated buckets", () => {
  withBucketStatePath((bucketStatePath) => {
    const options = {
      config: BUCKET_CONFIG,
      profileId: "account-a",
      bucketStatePath,
      autoReceiveEnabled: false,
      nowMs: 0,
    };

    const before = summarizeWaterwheelStatus(sync({ water: 0 }), options);
    const afterGenerationInterval = summarizeWaterwheelStatus(sync({ water: 0 }), {
      ...options,
      nowMs: 30_000,
    });

    assert.equal(before.storedBucketCount, 0);
    assert.equal(afterGenerationInterval.storedBucketCount, 1);
    assert.equal(afterGenerationInterval.canReceive, false);
  });
});

test("regression: no generated bucket cannot schedule a receive", () => {
  withBucketStatePath((bucketStatePath) => {
    const status = summarizeWaterwheelStatus(sync({ water: 0 }), {
      config: BUCKET_CONFIG,
      profileId: "account-a",
      bucketStatePath,
      autoReceiveEnabled: true,
      nowMs: 0,
    });

    assert.equal(status.storedBucketCount, 0);
    assert.equal(status.canReceive, false);
    assert.deepEqual(getAutoWaterwheelActions(status), []);
  });
});

test("regression: daily remaining quota is distinct from stored bucket inventory", () => {
  withBucketStatePath((bucketStatePath) => {
    const status = summarizeWaterwheelStatus(sync({ water: 9, count: 2 }), {
      config: BUCKET_CONFIG,
      profileId: "account-a",
      bucketStatePath,
      autoReceiveEnabled: false,
      nowMs: 0,
    });

    assert.equal(status.storedBucketCount, 0);
    assert.equal(status.storedBucketMax, 2);
    assert.equal(status.claimedBucketCount, 2);
    assert.equal(status.remainingDailyBucketCount, 8);
    assert.equal(status.remainingBucketCount, 8);
    assert.notEqual(status.remainingBucketCount, status.storedBucketCount);
  });
});
