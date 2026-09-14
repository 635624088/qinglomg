import assert from "node:assert/strict";
import test from "node:test";

import { getAutoPearlActions, summarizePearlStatus } from "./pearl-state.mjs";

const NOW_MS = Date.parse("2026-06-16T02:30:00.000Z");

function makePearlConfig() {
  return {
    sourcePath: "test",
    hireItemId: 9001,
    hireTimeSeconds: 3600,
    gatherCdSeconds: 600,
    restTimeSeconds: 1800,
    places: {
      1: { id: 1 },
      2: { id: 2 },
      3: { id: 3 },
    },
  };
}

test("summarizePearlStatus computes receivable pearls and idle pearl places", () => {
  const status = summarizePearlStatus(
    {
      $usrTot: {
        data: {
          bag: {
            9001: 2,
          },
        },
      },
      pearlTot: {
        pearl: {
          recvDailyDate: "2026-06-15T00:00:00.000Z",
        },
        placeMap: {
          1: {
            placeId: 1,
            laborUid: 7001,
            laborEndTime: "2026-06-16T03:00:00.000Z",
            everyMakeNum: 2,
            recvCnt: 1,
            surplusRecvNum: 1,
          },
          2: {
            placeId: 2,
            laborEndTime: "2026-06-16T01:00:00.000Z",
            everyMakeNum: 2,
            recvCnt: 6,
            surplusRecvNum: 0,
          },
        },
      },
    },
    {
      nowMs: NOW_MS,
      pearlConfig: makePearlConfig(),
    },
  );

  assert.equal(status.exists, true);
  assert.equal(status.canRecvDailyFree, true);
  assert.equal(status.hireItemId, 9001);
  assert.equal(status.hireItemCount, 2);
  assert.equal(status.canRecvNum, 5);
  assert.deepEqual(status.freePlaceIds, [2]);
  assert.equal(status.placeRows.find((item) => item.placeId === 1).state, "working");
  assert.equal(status.placeRows.find((item) => item.placeId === 2).state, "idle");
  assert.equal(status.placeRows.find((item) => item.placeId === 3).state, "locked");
});

test("summarizePearlStatus includes hired player nickname in pearl place rows", () => {
  const status = summarizePearlStatus(
    {
      $usrTot: {
        data: {
          bag: {},
        },
      },
      pearlTot: {
        pearl: {
          recvDailyDate: "2026-06-16T00:00:00.000Z",
        },
        placeMap: {
          1: {
            placeId: 1,
            laborUid: 7001,
            laborEndTime: "2026-06-16T03:00:00.000Z",
            everyMakeNum: 2,
          },
          2: {
            placeId: 2,
            laborUid: 7002,
            laborEndTime: "2026-06-16T03:00:00.000Z",
            everyMakeNum: 2,
          },
        },
        otherHireMap: {
          7001: {
            nickName: "小花匠",
            laborEndTime: "2026-06-16T03:00:00.000Z",
          },
        },
        recommendUserMap: {
          7002: {
            uid: 7002,
            nickname: "采珠人",
          },
        },
      },
    },
    {
      nowMs: NOW_MS,
      pearlConfig: makePearlConfig(),
    },
  );

  assert.equal(status.placeRows.find((item) => item.placeId === 1).laborNickname, "小花匠");
  assert.equal(status.placeRows.find((item) => item.placeId === 1).laborDisplayText, "小花匠 (7001)");
  assert.equal(status.placeRows.find((item) => item.placeId === 2).laborNickname, "采珠人");
  assert.equal(status.placeRows.find((item) => item.placeId === 2).laborDisplayText, "采珠人 (7002)");
});

test("summarizePearlStatus treats completed empty places as hireable despite stale labor fields", () => {
  const status = summarizePearlStatus(
    {
      $usrTot: {
        data: {
          bag: {
            9001: 2,
          },
        },
      },
      pearlTot: {
        pearl: {
          recvDailyDate: "2026-06-16T00:00:00.000Z",
        },
        placeMap: {
          1: {
            placeId: 1,
            laborUid: 7001,
            laborEndTime: "2026-06-16T03:00:00.000Z",
            everyMakeNum: 0,
            recvCnt: 0,
            surplusRecvNum: 0,
            eventId: 0,
          },
        },
      },
    },
    {
      nowMs: NOW_MS,
      pearlConfig: makePearlConfig(),
    },
  );

  const place = status.placeRows.find((item) => item.placeId === 1);
  assert.equal(place.state, "idle");
  assert.equal(place.stateText, "空闲");
  assert.equal(place.canHire, true);
  assert.equal(place.laborUid, null);
  assert.equal(place.laborDisplayText, "-");
  assert.equal(place.laborEndTime, null);
  assert.equal(place.laborEndTimeText, "-");
  assert.deepEqual(status.freePlaceIds, [1]);
  assert.equal(status.canRecvNum, 0);
});

test("getAutoPearlActions hires only world recommended users into idle places", () => {
  const actions = getAutoPearlActions({
    exists: true,
    canRecvDailyFree: false,
    canRecvNum: 8,
    hireItemCount: 8,
    freePlaceIds: [1, 2],
    recommendList: [7001, 7002, 7003],
    unavailableRecommendUids: new Set([7002]),
  }, {
    maxHires: 2,
    hireItemReserveCount: 6,
  });

  assert.deepEqual(actions, [
    { type: "recvOneKey", iface: "gs.pearlPlace.recvOneKey", args: {} },
    {
      type: "hire",
      iface: "gs.pearlPlace.hire",
      args: { placeId: 1, dstUid: 7001 },
      placeId: 1,
      dstUid: 7001,
      source: "worldRecommend",
    },
    {
      type: "hire",
      iface: "gs.pearlPlace.hire",
      args: { placeId: 2, dstUid: 7003 },
      placeId: 2,
      dstUid: 7003,
      source: "worldRecommend",
    },
  ]);
});

test("getAutoPearlActions accepts object world recommendation rows", () => {
  const actions = getAutoPearlActions({
    exists: true,
    canRecvDailyFree: false,
    canRecvNum: 0,
    hireItemCount: 7,
    freePlaceIds: [1],
    recommendList: [{ uid: 7001, nickName: "小花匠" }],
    unavailableRecommendUids: new Set(),
  }, {
    maxHires: 1,
    hireItemReserveCount: 6,
  }, { hireItemReserveCount: 6 });

  assert.deepEqual(actions, [
    {
      type: "hire",
      iface: "gs.pearlPlace.hire",
      args: { placeId: 1, dstUid: 7001 },
      placeId: 1,
      dstUid: 7001,
      source: "worldRecommend",
    },
  ]);
});

test("getAutoPearlActions keeps six hire items reserved", () => {
  const actions = getAutoPearlActions({
    exists: true,
    canRecvDailyFree: false,
    canRecvNum: 0,
    hireItemCount: 6,
    freePlaceIds: [1],
    recommendList: [7001],
    unavailableRecommendUids: new Set(),
  });

  assert.deepEqual(actions, []);
});

test("getAutoPearlActions spends only hire items above the six-card reserve", () => {
  const actions = getAutoPearlActions({
    exists: true,
    canRecvDailyFree: false,
    canRecvNum: 0,
    hireItemCount: 7,
    freePlaceIds: [1, 2],
    recommendList: [7001, 7002],
    unavailableRecommendUids: new Set(),
  }, {
    maxHires: 2,
    hireItemReserveCount: 6,
  });

  assert.deepEqual(actions, [
    {
      type: "hire",
      iface: "gs.pearlPlace.hire",
      args: { placeId: 1, dstUid: 7001 },
      placeId: 1,
      dstUid: 7001,
      source: "worldRecommend",
    },
  ]);
});

function makeHireablePearlStatus({ hireItemCount }) {
  return {
    exists: true,
    canRecvDailyFree: false,
    canRecvNum: 0,
    hireItemCount,
    freePlaceIds: [1, 2],
    recommendList: [7001, 7002],
    unavailableRecommendUids: new Set(),
  };
}

test("getAutoPearlActions keeps one hundred hire items by default", () => {
  const actions = getAutoPearlActions(makeHireablePearlStatus({ hireItemCount: 101 }));
  assert.equal(actions.filter((action) => action.type === "hire").length, 1);
  const blocked = getAutoPearlActions(makeHireablePearlStatus({ hireItemCount: 100 }));
  assert.equal(blocked.filter((action) => action.type === "hire").length, 0);
});

test("getAutoPearlActions uses the configured reserve", () => {
  for (const [reserve, count, expected] of [[0, 2, 2], [6, 7, 1], [20, 21, 1], [100, 101, 1]]) {
    const actions = getAutoPearlActions(
      makeHireablePearlStatus({ hireItemCount: count }),
      { hireItemReserveCount: reserve },
    );
    assert.equal(actions.filter((action) => action.type === "hire").length, expected);
  }
});

test("summarizePearlStatus excludes monthly-card pearl places from auto hire when not active", () => {
  const status = summarizePearlStatus(
    {
      $usrTot: {
        data: {
          bag: {
            9001: 2,
          },
        },
      },
      pearlTot: {
        pearl: {},
        placeMap: {
          1: {
            placeId: 1,
          },
          4: {
            placeId: 4,
          },
        },
      },
    },
    {
      nowMs: NOW_MS,
      pearlConfig: {
        ...makePearlConfig(),
        places: {
          1: { id: 1 },
          4: { id: 4, mCardUnlock: 1 },
        },
      },
    },
  );

  assert.deepEqual(status.freePlaceIds, [1]);
  assert.equal(status.placeRows.find((item) => item.placeId === 4).state, "locked");
  assert.equal(status.placeRows.find((item) => item.placeId === 4).canHire, false);
});
