import assert from "node:assert/strict";
import test from "node:test";

import {
  getState,
  summarizeLand,
} from "./garden-state.mjs";
import {
  getFmlLandHarvestPlan,
  summarizeFmlLandStatus,
} from "./fml-land-state.mjs";
import {
  getMaterialShopMidnightRefreshPlan,
} from "./material-shop-state.mjs";
import {
  getAutoPearlActions,
  summarizePearlStatus,
} from "./pearl-state.mjs";
import {
  getAutoWaterwheelActions,
  summarizeWaterwheelStatus,
} from "./waterwheel-state.mjs";
import { createWaterwheelBucketState } from "./waterwheel-bucket-state.mjs";
import { createTimeAuthority } from "./time-authority.mjs";

const { getNearMatureLandRows, getResourceActionNowMs } = await import(
  "./inspect-garden-dryrun.mjs?time-authority-resource-actions-test"
);

const SERVER_NOW_MS = Date.parse("2026-08-22T15:50:30.000Z");
const SLOW_LOCAL_NOW_MS = SERVER_NOW_MS - 60_000;
const FAST_LOCAL_NOW_MS = SERVER_NOW_MS + 60_000;

function makeAcceptedAuthority({ localNowMs = SLOW_LOCAL_NOW_MS, serverNowMs = SERVER_NOW_MS, maxAgeMs = 120_000 } = {}) {
  const authority = createTimeAuthority({ maxAgeMs, nowFn: () => localNowMs });
  authority.beginHeartbeat(localNowMs - 400);
  return authority.recordHeartbeat({
    serverMs: serverNowMs - 200,
    responseAtMs: localNowMs,
  });
}

function makeAuthoritySync(authority) {
  return { $timeAuthority: authority };
}

test("resource action clock uses a trusted corrected sample and fails closed for missing or expired samples", () => {
  const accepted = makeAcceptedAuthority();
  const trustedSync = makeAuthoritySync(accepted);

  assert.equal(
    getResourceActionNowMs(trustedSync, { nowMs: SLOW_LOCAL_NOW_MS }),
    SERVER_NOW_MS,
  );
  assert.equal(
    getResourceActionNowMs({}, { nowMs: SLOW_LOCAL_NOW_MS }),
    SLOW_LOCAL_NOW_MS,
  );
  assert.equal(
    getResourceActionNowMs({}, { nowMs: FAST_LOCAL_NOW_MS }),
    FAST_LOCAL_NOW_MS,
  );
  assert.equal(
    getResourceActionNowMs(
      makeAuthoritySync({ trusted: true, correctedNowMs: SERVER_NOW_MS }),
      { nowMs: SLOW_LOCAL_NOW_MS },
    ),
    SLOW_LOCAL_NOW_MS,
  );
  assert.equal(
    getResourceActionNowMs(
      makeAuthoritySync({ trusted: false, correctedNowMs: SERVER_NOW_MS }),
      { nowMs: SLOW_LOCAL_NOW_MS },
    ),
    SLOW_LOCAL_NOW_MS,
  );

  const expired = makeAcceptedAuthority({ maxAgeMs: 30_000 });
  assert.equal(
    getResourceActionNowMs(
      makeAuthoritySync(expired),
      { nowMs: SLOW_LOCAL_NOW_MS + 31_000 },
    ),
    SLOW_LOCAL_NOW_MS + 31_000,
  );
});

test("trusted action time controls free speed-up and ordinary mature-land gates", () => {
  const trustedSync = makeAuthoritySync(makeAcceptedAuthority());
  const nearMatureSync = {
    ...trustedSync,
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {
            state: 2,
            flowerId: 23001,
            nextTime: new Date(SERVER_NOW_MS + 30_000).toISOString(),
          },
        },
      },
    },
  };

  assert.equal(
    getNearMatureLandRows(
      nearMatureSync,
      getResourceActionNowMs(nearMatureSync, { nowMs: SLOW_LOCAL_NOW_MS }),
    ).length,
    1,
  );
  assert.equal(
    getNearMatureLandRows(nearMatureSync, SLOW_LOCAL_NOW_MS).length,
    0,
  );
  assert.equal(
    getNearMatureLandRows(nearMatureSync, FAST_LOCAL_NOW_MS).length,
    0,
  );
  assert.deepEqual(
    getState(nearMatureSync, FAST_LOCAL_NOW_MS).recommendation.harvestLandIds,
    [1001],
  );

  const matureSync = {
    ...trustedSync,
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {
            state: 2,
            flowerId: 23001,
            nextTime: new Date(SERVER_NOW_MS - 30_000).toISOString(),
          },
        },
      },
    },
  };
  assert.deepEqual(
    getState(matureSync, getResourceActionNowMs(matureSync, { nowMs: SLOW_LOCAL_NOW_MS }))
      .recommendation.harvestLandIds,
    [1001],
  );
  assert.deepEqual(summarizeLand(matureSync, SLOW_LOCAL_NOW_MS).mature, []);
});

test("trusted action time controls a waterwheel receive decision at the water threshold", () => {
  const bucketConfig = { bucketCreateCd: 30, bucketExistMax: 8, bucketGetMax: 60 };
  const generatedBucketState = {
    ...createWaterwheelBucketState({ profileId: "default", nowMs: 0, config: bucketConfig }),
    storedBucketCount: 1,
    nextGenerationAtMs: null,
  };
  const sync = {
    ...makeAuthoritySync(makeAcceptedAuthority()),
    $usrTot: {
      data: {
        bag: { 7: 15 },
        itemExtMap: {
          7: { lems: SERVER_NOW_MS - 90_000, cd: 60_000, resetNum: 65 },
        },
      },
    },
    waterwheel: { count: 0, advList: [] },
  };
  const trustedStatus = summarizeWaterwheelStatus(sync, {
    nowMs: getResourceActionNowMs(sync, { nowMs: SLOW_LOCAL_NOW_MS }),
    config: bucketConfig,
    bucketState: generatedBucketState,
  });
  const localStatus = summarizeWaterwheelStatus(sync, {
    nowMs: SLOW_LOCAL_NOW_MS,
    config: bucketConfig,
    bucketState: generatedBucketState,
  });

  assert.equal(trustedStatus.waterDropCount, 16);
  assert.deepEqual(getAutoWaterwheelActions(trustedStatus), []);
  assert.equal(localStatus.waterDropCount, 15);
  assert.equal(getAutoWaterwheelActions(localStatus).length, 1);
});

test("trusted action time enables a pearl hire only after the labor cooldown ends", () => {
  const sync = {
    ...makeAuthoritySync(makeAcceptedAuthority()),
    $usrTot: { data: { bag: { 9001: 101 } } },
    pearlTot: {
      pearl: { recvDailyDate: new Date(SERVER_NOW_MS).toISOString() },
      placeMap: {
        1: {
          laborUid: 7001,
          laborEndTime: new Date(SERVER_NOW_MS - 30_000).toISOString(),
          everyMakeNum: 2,
          recvCnt: 6,
          surplusRecvNum: 0,
        },
      },
      recommendList: [7002],
    },
  };
  const config = {
    sourcePath: "test",
    hireItemId: 9001,
    hireTimeSeconds: 3_600,
    gatherCdSeconds: 600,
    restTimeSeconds: 0,
    places: { 1: { id: 1 } },
  };
  const trustedStatus = summarizePearlStatus(sync, {
    nowMs: getResourceActionNowMs(sync, { nowMs: SLOW_LOCAL_NOW_MS }),
    pearlConfig: config,
  });
  const localStatus = summarizePearlStatus(sync, {
    nowMs: SLOW_LOCAL_NOW_MS,
    pearlConfig: config,
  });

  assert.deepEqual(getAutoPearlActions(trustedStatus, {
    maxHires: 1,
    hireItemReserveCount: 100,
  }).map((action) => action.type), ["hire"]);
  assert.deepEqual(getAutoPearlActions(localStatus, {
    maxHires: 1,
    hireItemReserveCount: 100,
  }), []);
});

test("trusted action time controls FML maturity and midnight material refresh", () => {
  const trustedSync = makeAuthoritySync(makeAcceptedAuthority());
  const fmlSync = {
    ...trustedSync,
    fmlTot: {
      fmlLand: {
        landMap: {
          401: {
            flwId: 23105,
            lvl: 3,
            matureFlwCnt: 0,
            lastCalcTime: new Date(SERVER_NOW_MS - 60_000).toISOString(),
          },
        },
      },
    },
  };
  const fmlOptions = {
    fmlLandLevelConfig: {
      fmlLandLvlById: new Map([["3", { id: 3, time: 60, stock: 6 }]]),
    },
  };
  const trustedFml = summarizeFmlLandStatus(fmlSync, {
    ...fmlOptions,
    nowMs: getResourceActionNowMs(fmlSync, { nowMs: SLOW_LOCAL_NOW_MS }),
  });
  const localFml = summarizeFmlLandStatus(fmlSync, {
    ...fmlOptions,
    nowMs: SLOW_LOCAL_NOW_MS,
  });
  assert.deepEqual(getFmlLandHarvestPlan(trustedFml)?.args.landIds, [401]);
  assert.equal(getFmlLandHarvestPlan(localFml), null);

  const materialSync = {
    ...trustedSync,
    $usrTot: { data: { dmd: 100, gld: 1_000, bag: {} } },
    shopCultivate: { mrCount: 0, infoMap: {}, bRecord: {} },
  };
  const materialOptions = {
    enabled: true,
    windowStart: "23:50",
    windowEnd: "24:00",
    maxCostYuanbao: 4,
    materialShopConfig: { freeRefreshTimes: 3 },
  };
  assert.equal(
    getMaterialShopMidnightRefreshPlan(materialSync, {
      ...materialOptions,
      nowMs: getResourceActionNowMs(materialSync, { nowMs: SLOW_LOCAL_NOW_MS }),
    }).shouldRefresh,
    true,
  );
  assert.equal(
    getMaterialShopMidnightRefreshPlan(materialSync, {
      ...materialOptions,
      nowMs: SLOW_LOCAL_NOW_MS,
    }).shouldRefresh,
    false,
  );
});
