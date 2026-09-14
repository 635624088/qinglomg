import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeGameSync } from "./garden-state.mjs";
import {
  createTeamOrderArchive,
  createTeamOrderRunId,
} from "./team-order-archive.mjs";
import {
  TEAM_ORDER_IFACES,
} from "./team-order-state.mjs";
import {
  createTeamOrderRunner,
  TEAM_ORDER_LIMITS,
  TEAM_ORDER_UI_TIMINGS,
} from "./team-order-runner.mjs";

function syncWithTeam(orderTeam, bag = {}, usrData = {}) {
  return {
    orderTeamTot: { orderTeam },
    $usrTot: { data: { id: "u1", ...usrData, bag } },
  };
}

function response(value) {
  return { value, dsName: null, errMsg: null };
}

function fixtureRunnerConfig() {
  return {
    durationSeconds: 50,
    maxOrderNum: 160,
    refreshPerSecond: 4,
    paidRenewCost: [1, 60],
    rewardBase: [[2, 8_000], [11, 10_000]],
    orders: new Map(
      Array.from({ length: 160 }, (_, index) => [
        index + 1,
        {
          orderNum: index + 1,
          flowerNum: 15,
          magnification: index < 10 ? 100 : 120,
        },
      ]),
    ),
  };
}

function createRecordingArchive(overrides = {}) {
  const calls = {
    start: [],
    append: [],
    finish: [],
    flush: 0,
  };
  const archive = {
    async start(value) {
      calls.start.push(value);
      return overrides.start?.(value);
    },
    async append(value) {
      calls.append.push(value);
      return overrides.append?.(value);
    },
    async finish(value) {
      calls.finish.push(value);
      return overrides.finish?.(value);
    },
    async flush() {
      calls.flush += 1;
      return overrides.flush?.();
    },
  };
  return { archive, calls };
}

function createRecordingOneShotArchive(overrides = {}) {
  const calls = {
    commit: [],
    start: [],
    append: [],
    finish: [],
    flush: 0,
  };
  const archive = {
    async commit(value) {
      calls.commit.push(value);
      return overrides.commit?.(value);
    },
    async start(value) {
      calls.start.push(value);
      return overrides.start?.(value);
    },
    async append(value) {
      calls.append.push(value);
      return overrides.append?.(value);
    },
    async finish(value) {
      calls.finish.push(value);
      return overrides.finish?.(value);
    },
    async flush() {
      calls.flush += 1;
      return overrides.flush?.();
    },
  };
  return { archive, calls };
}

function createFixtureRunner({
  useProductionArchiveClock = false,
  ...overrides
} = {}) {
  const clock = overrides.clock || {
    epochMs: 10_000,
    monotonicMs: 0,
    sleeps: [],
  };
  const archiveClock = overrides.archiveClock || {
    monotonicMs: 0,
    sleeps: [],
  };
  const archiveFixture =
    overrides.archiveFixture || createRecordingArchive();
  const archiveIdentities = [];
  const runner = createTeamOrderRunner({
    profileId: "p1",
    uid: "u1",
    request: async () => response({}),
    mergeSync: mergeGameSync,
    refreshTruth: async (syncValue) => syncValue,
    getExperienceGuard: () => ({ blocked: false, reasonText: null }),
    createArchive(identity) {
      archiveIdentities.push(identity);
      return archiveFixture.archive;
    },
    nowMs: () => clock.epochMs + clock.monotonicMs,
    monotonicMs: () => clock.monotonicMs,
    sleep: async (milliseconds) => {
      clock.sleeps.push(milliseconds);
      clock.monotonicMs += milliseconds;
    },
    ...(!useProductionArchiveClock ? {
      archiveMonotonicMs: () => archiveClock.monotonicMs,
    } : {}),
    archiveSleep: async (milliseconds) => {
      archiveClock.sleeps.push(milliseconds);
      archiveClock.monotonicMs += milliseconds;
      await new Promise((resolve) => setImmediate(resolve));
    },
    uiTimings: {
      dialogReadyMs: 0,
      nextActionMs: 0,
      rewardReadyMs: 0,
    },
    signal: null,
    shouldStop: async () => null,
    ...overrides,
  });
  return {
    runner,
    clock,
    archiveClock,
    archive: archiveFixture.calls,
    archiveIdentities,
  };
}

function activeOrder({
  status = 2,
  startTime = 10_000,
  activeTime = startTime + 125,
  orderNum = 1,
  flowerId = 23_001,
  bag = { 23_001: 15 },
  dmd = null,
  ...orderFields
} = {}) {
  return syncWithTeam(
    {
      status,
      startTime,
      activeTime,
      orderNum,
      flowerId,
      ...orderFields,
    },
    bag,
    dmd == null ? {} : { dmd },
  );
}

async function settleWithin(promise, label, timeoutMs = 250) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withTempDir(prefix, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 25,
    });
  }
}

test("exports the frozen deterministic safety limits", () => {
  assert.deepEqual(TEAM_ORDER_LIMITS, {
    safetyMarginMs: 0,
    maxRequests: 400,
    maxUnknownState: 8,
  });
  assert.deepEqual(TEAM_ORDER_UI_TIMINGS, {
    dialogReadyMs: 200,
    nextActionMs: 300,
    maxCompleteMs: 600,
    rewardReadyMs: 1_300,
  });
});

test("status 0 without a valid stored order sends no request", async () => {
  const requests = [];
  const { runner } = createFixtureRunner({
    request: async (...args) => {
      requests.push(args);
      return response({});
    },
  });

  const result = await runner.handle(
    syncWithTeam({
      status: 0,
      storedOrders: [
        { npcId: 1, expireTime: 9_999 },
        { npcId: 2, expireTime: null },
      ],
    }),
    { trigger: "startup", config: fixtureRunnerConfig() },
  );

  assert.deepEqual(requests, []);
  assert.equal(result.handled, false);
  assert.equal(result.actionCount, 0);
  assert.equal(result.finalReason, "idle");
});

test("a missing order object is the client's idle status and sends no request", async () => {
  const requests = [];
  const { runner } = createFixtureRunner({
    request: async (...args) => {
      requests.push(args);
      return response({});
    },
  });

  const result = await runner.handle(
    {
      orderTeamTot: {},
      $usrTot: { data: { bag: {} } },
    },
    { trigger: "startup", config: fixtureRunnerConfig() },
  );

  assert.deepEqual(requests, []);
  assert.equal(result.handled, false);
  assert.equal(result.actionCount, 0);
  assert.equal(result.finalReason, "idle");
});

test("status 0 restores only the earliest unexpired stored order", async () => {
  const requests = [];
  const fixture = createFixtureRunner({
    request: async (iface, args) => {
      requests.push({ iface, args });
      return response(syncWithTeam({
        status: 0,
        startTime: 8_000,
        activeTime: 8_125,
      }));
    },
  });

  const result = await fixture.runner.handle(
    syncWithTeam({
      status: 0,
      storedOrders: [
        { npcId: 3, expireTime: 9_000 },
        { npcId: 2, expireTime: 30_000 },
        { npcId: 1, expireTime: 20_000 },
      ],
    }),
    { trigger: "startup", config: fixtureRunnerConfig() },
  );

  assert.deepEqual(requests, [{
    iface: TEAM_ORDER_IFACES.takeStoredOrder,
    args: { npcId: 1 },
  }]);
  assert.equal(result.handled, true);
  assert.equal(result.actionCount, 1);
  assert.equal(
    fixture.archive.append.filter((event) => event.action === "restore").length,
    1,
  );
  assert.equal(fixture.archiveIdentities[0].startTime, 8_000);
  assert.equal(fixture.archiveIdentities[0].activeTime, 8_125);
});

test("stored restore without confirmed server times never creates an empty-time archive", async () => {
  const fixture = createFixtureRunner({
    request: async () => response(syncWithTeam({ status: 0 })),
  });

  const result = await fixture.runner.handle(syncWithTeam({
    status: 0,
    storedOrders: [{ npcId: 1, expireTime: 20_000 }],
  }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.deepEqual(fixture.archiveIdentities, []);
  assert.equal(fixture.archive.start.length, 0);
  assert.equal(fixture.archive.finish.length, 0);
  assert.equal(fixture.archive.flush, 0);
});

test("stored restore buffers its action until truth refresh confirms stable server times", async () => {
  const fixture = createFixtureRunner({
    request: async () => ({ value: null, dsName: null, errMsg: null }),
    refreshTruth: async () => activeOrder({
      startTime: 9_000,
      activeTime: 9_125,
    }),
  });

  const result = await fixture.runner.handle(syncWithTeam({
    status: 0,
    storedOrders: [{ npcId: 1, expireTime: 20_000 }],
  }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "request-timeout-resynced");
  assert.equal(fixture.archiveIdentities[0].startTime, 9_000);
  assert.equal(
    fixture.archive.append.filter((event) => event.action === "restore").length,
    1,
  );
});

test("status 1 accepts only the free order and never emits a paid request", async () => {
  const requests = [];
  const { runner } = createFixtureRunner({
    request: async (iface, args) => {
      requests.push({ iface, args });
      return response(syncWithTeam({ status: 0 }));
    },
  });

  await runner.handle(syncWithTeam({ status: 1 }), {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests, [{
    iface: TEAM_ORDER_IFACES.takeOrder,
    args: { isAgree: true, isCost: false },
  }]);
  assert.equal(requests.some((item) => item.args?.isCost === true), false);
  assert.equal(
    requests.some((item) => /buy|purchase/i.test(item.iface)),
    false,
  );
});

test("status 1 waits for stable server identity before archiving the accepted challenge", async () => {
  let requestCount = 0;
  const fixture = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return response(activeOrder({
          startTime: 20_000,
          activeTime: 20_125,
        }));
      }
      return { value: null, dsName: null, errMsg: null };
    },
  });

  const result = await fixture.runner.handle(syncWithTeam({ status: 1 }), {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "request-timeout-resynced");
  assert.deepEqual(fixture.archiveIdentities, [{
    profileId: "p1",
    uid: "u1",
    startTime: 20_000,
    activeTime: 20_125,
    createdTime: null,
    trigger: "resident-order",
  }]);
  assert.equal(fixture.archive.start.length, 1);
  assert.equal(fixture.archive.append[0].action, "accept");
});

test("status 1 without stable server identity never creates an empty-time archive", async () => {
  const fixture = createFixtureRunner({
    request: async () => response(syncWithTeam({ status: 1 })),
  });

  const result = await fixture.runner.handle(syncWithTeam({ status: 1 }), {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "accept-unconfirmed");
  assert.deepEqual(fixture.archiveIdentities, []);
  assert.equal(fixture.archive.start.length, 0);
  assert.equal(fixture.archive.finish.length, 0);
  assert.equal(fixture.archive.flush, 0);
});

test("status 1 buffers accept until truth refresh confirms stable server times", async () => {
  const fixture = createFixtureRunner({
    request: async () => ({ value: null, dsName: null, errMsg: null }),
    refreshTruth: async () => activeOrder({
      startTime: 21_000,
      activeTime: 21_125,
    }),
  });

  const result = await fixture.runner.handle(syncWithTeam({ status: 1 }), {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "request-timeout-resynced");
  assert.equal(fixture.archiveIdentities[0].startTime, 21_000);
  assert.equal(
    fixture.archive.append.filter((event) => event.action === "accept").length,
    1,
  );
});

test("separate status 1 challenges derive different archives from confirmed server times", async () => {
  const identities = [];
  for (const [startTime, activeTime] of [[20_000, 20_125], [30_000, 30_125]]) {
    const fixture = createFixtureRunner({
      request: async () => response(activeOrder({
        status: 3,
        startTime,
        activeTime,
      })),
    });
    await fixture.runner.handle(syncWithTeam({ status: 1 }), {
      trigger: "resident-order",
      config: fixtureRunnerConfig(),
    });
    identities.push(fixture.archiveIdentities[0]);
  }

  assert.notDeepEqual(identities[0], identities[1]);
  assert.deepEqual(
    identities.map((identity) => [identity.startTime, identity.activeTime]),
    [[20_000, 20_125], [30_000, 30_125]],
  );
});

test("an admitted team order ignores the legacy experience guard and completes", async () => {
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    getExperienceGuard: () => ({
      blocked: true,
      reasonText: "experience threshold",
    }),
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (iface === TEAM_ORDER_IFACES.takeOrder) {
        return response(activeOrder({
          status: 3,
          startTime: 7_000,
          activeTime: 7_125,
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(syncWithTeam({
    status: 1,
    startTime: 7_000,
    activeTime: 7_125,
  }), {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests.map(({ iface }) => iface), [
    TEAM_ORDER_IFACES.takeOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.equal(result.finalReason, "server-ended");
  assert.equal(
    archive.append.filter((event) => event.action === "store").length,
    0,
  );
});

test("legacy experience guard never stores or interrupts the same admitted challenge", async () => {
  const requests = [];
  const pendingChallenge = syncWithTeam({
    status: 1,
    startTime: 7_000,
    activeTime: 7_125,
  });
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    getExperienceGuard: () => ({
      blocked: true,
      reasonText: "experience threshold",
    }),
    request: async (iface, args) => {
      requests.push({ iface, args });
      return response(pendingChallenge);
    },
  });

  const first = await runner.handle(pendingChallenge, {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });
  const second = await runner.handle(pendingChallenge, {
    trigger: "ordinary-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(first.finalReason, "accept-unconfirmed");
  assert.equal(second.finalReason, "accept-unconfirmed");
  assert.deepEqual(requests.map(({ iface }) => iface), [
    TEAM_ORDER_IFACES.takeOrder,
    TEAM_ORDER_IFACES.takeOrder,
  ]);
  assert.equal(requests.some(({ iface }) => iface === TEAM_ORDER_IFACES.storeOrder), false);
});

test("status 3 settles once and an unknown response is confirmed by refreshTruth", async () => {
  const requests = [];
  const refreshes = [];
  const { runner } = createFixtureRunner({
    request: async (iface, args) => {
      requests.push({ iface, args });
      return { value: null, dsName: null, errMsg: null };
    },
    refreshTruth: async (syncValue, label) => {
      refreshes.push({ syncValue, label });
      return syncWithTeam({ status: 0 });
    },
  });

  const result = await runner.handle(syncWithTeam({ status: 3 }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests, [{
    iface: TEAM_ORDER_IFACES.recvRwd,
    args: {},
  }]);
  assert.equal(refreshes.length, 1);
  assert.equal(result.actionCount, 1);
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.syncValue.orderTeamTot.orderTeam.status, 0);
});

test("status 3 treats already-received errors as idempotent only after one truth refresh", async () => {
  for (const errMsg of ["already received", "奖励已领取"]) {
    let requestCount = 0;
    let refreshCount = 0;
    const { runner } = createFixtureRunner({
      request: async () => {
        requestCount += 1;
        return { value: null, dsName: "ORDER_DONE", errMsg };
      },
      refreshTruth: async () => {
        refreshCount += 1;
        return syncWithTeam({ status: 0 });
      },
    });

    const result = await runner.handle(syncWithTeam({ status: 3 }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });

    assert.equal(requestCount, 1);
    assert.equal(refreshCount, 1);
    assert.equal(result.finalReason, "server-ended");
  }
});

test("status 3 keeps unknown and already-received settlement unconfirmed when truth remains pending", async () => {
  for (const mode of ["unknown", "already-received"]) {
    let requestCount = 0;
    let refreshCount = 0;
    const { runner } = createFixtureRunner({
      request: async () => {
        requestCount += 1;
        return mode === "unknown"
          ? { value: null, dsName: null, errMsg: null }
          : { value: null, dsName: "ORDER_DONE", errMsg: "already received" };
      },
      refreshTruth: async () => {
        refreshCount += 1;
        return syncWithTeam({ status: 3 });
      },
    });

    const result = await runner.handle(syncWithTeam({ status: 3 }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });

    assert.equal(requestCount, 1);
    assert.equal(refreshCount, 1);
    assert.equal(
      result.finalReason,
      mode === "unknown" ? "settlement-unconfirmed" : "server-rejected",
    );
  }
});

test("protected flowers refresh instead of submit even with enough stock", async () => {
  const cases = [
    { flowerId: 23_001, flowerName: "曼珠沙华" },
    { flowerId: 23_002, flowerName: "伯利恒之星" },
  ];

  for (const { flowerId, flowerName } of cases) {
    const calls = [];
    const fixture = createFixtureRunner({
      request: async (iface) => {
        calls.push(iface);
        if (
          iface === TEAM_ORDER_IFACES.refreshOrder
          || iface === TEAM_ORDER_IFACES.submitOrder
        ) {
          return response(activeOrder({
            status: 3,
            flowerId,
            bag: { [flowerId]: 15 },
          }));
        }
        return response(syncWithTeam({ status: 0 }));
      },
    });

    const result = await fixture.runner.handle(activeOrder({
      flowerId,
      bag: { [flowerId]: 15 },
    }), {
      trigger: "protected-flower",
      config: fixtureRunnerConfig(),
      flowerNames: { [flowerId]: flowerName },
    });

    assert.deepEqual(calls, [
      TEAM_ORDER_IFACES.refreshOrder,
      TEAM_ORDER_IFACES.recvRwd,
    ], flowerName);
    assert.equal(result.submittedCount, 0, flowerName);
    assert.equal(result.refreshedCount, 1, flowerName);
    assert.equal(
      fixture.archive.append.some((event) => (
        event.action === "protected-flower"
        && event.status === "skipped"
        && event.flowerName === flowerName
      )),
      true,
      flowerName,
    );
    assert.equal(
      fixture.archive.append.some((event) => event.action === "inventory-shortage"),
      false,
      flowerName,
    );
  }
});

test("consecutive protected flowers keep refreshing without inventory-shortage telemetry", async () => {
  const calls = [];
  let refreshCount = 0;
  const fixture = createFixtureRunner({
    request: async (iface) => {
      calls.push(iface);
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        refreshCount += 1;
        return response(activeOrder({
          status: refreshCount === 2 ? 3 : 2,
          flowerId: 23_002,
          bag: { 23_002: 15 },
        }));
      }
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({ status: 3, flowerId: 23_002 }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await fixture.runner.handle(activeOrder({
    flowerId: 23_001,
    bag: { 23_001: 0 },
  }), {
    trigger: "protected-flower-consecutive",
    config: fixtureRunnerConfig(),
    flowerNames: {
      23_001: "曼珠沙华",
      23_002: "伯利恒之星",
    },
  });

  assert.deepEqual(calls, [
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.equal(result.submittedCount, 0);
  assert.equal(result.refreshedCount, 2);
  assert.equal(
    fixture.archive.append.filter(
      (event) => event.action === "protected-flower",
    ).length,
    2,
  );
  assert.equal(
    fixture.archive.append.some((event) => event.action === "inventory-shortage"),
    false,
  );
});

test("active challenge submits enough stock, refreshes shortage, and settles serially", async () => {
  const calls = [];
  let activeRequestCount = 0;
  let maximumActiveRequestCount = 0;
  const { runner } = createFixtureRunner({
    request: async (iface) => {
      activeRequestCount += 1;
      maximumActiveRequestCount = Math.max(
        maximumActiveRequestCount,
        activeRequestCount,
      );
      try {
        await Promise.resolve();
        calls.push(iface);
        if (iface === TEAM_ORDER_IFACES.submitOrder) {
          return response(activeOrder({
            orderNum: 2,
            flowerId: 23_002,
            bag: { 23_001: 0, 23_002: 0 },
          }));
        }
        if (iface === TEAM_ORDER_IFACES.refreshOrder) {
          return response(activeOrder({
            status: 3,
            orderNum: 2,
            flowerId: 23_003,
            bag: { 23_002: 0 },
          }));
        }
        return response(syncWithTeam({ status: 0 }));
      } finally {
        activeRequestCount -= 1;
      }
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(calls, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.equal(maximumActiveRequestCount, 1);
  assert.equal(result.submittedCount, 1);
  assert.equal(result.refreshedCount, 1);
});

test("confirmed unchanged submit response never refreshes truth or locally increments orderNum", async () => {
  let requestCount = 0;
  let refreshCount = 0;
  const unchanged = activeOrder();
  const { runner } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      return response(unchanged);
    },
    refreshTruth: async () => {
      refreshCount += 1;
      return unchanged;
    },
    shouldStop: async () => (
      requestCount >= 1 ? { reason: "user-stop" } : null
    ),
  });

  const result = await runner.handle(unchanged, {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 1);
  assert.equal(refreshCount, 0);
  assert.equal(result.submittedCount, 1);
  assert.equal(result.syncValue.orderTeamTot.orderTeam.orderNum, 1);
  assert.equal(result.finalReason, "user-stop");
});

test("a timed-out submit refreshes truth once and is never blindly retried", async () => {
  let requestCount = 0;
  let refreshCount = 0;
  const requestedIfaces = [];
  const timeout = Object.assign(new Error("socket timeout original"), {
    code: "ETIMEDOUT",
    token: "must-not-be-copied",
  });
  const { runner, archive } = createFixtureRunner({
    request: async (iface) => {
      requestCount += 1;
      requestedIfaces.push(iface);
      if (requestCount === 1) throw timeout;
      return response(syncWithTeam({ status: 0 }));
    },
    refreshTruth: async () => {
      refreshCount += 1;
      return activeOrder({
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 0 },
      });
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 2);
  assert.equal(refreshCount, 1);
  assert.deepEqual(requestedIfaces, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
  ]);
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.syncValue.orderTeamTot.orderTeam.orderNum, 2);
  const submit = archive.append.find((event) => event.action === "submit");
  assert.equal(submit.status, "success");
  assert.equal(submit.reason, "truth-confirmed");
  assert.equal(
    archive.append.some((event) => event.action === "failure"),
    false,
  );
});

test("a never-settling final submit yields at 50 seconds, settles rewards, and never overlaps truth refresh", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let settleRequest;
  let requestCount = 0;
  let refreshCount = 0;
  let requestSignal = null;
  const fixture = createFixtureRunner({
    clock,
    request: async (_iface, _args, _label, options) => {
      requestCount += 1;
      requestSignal = options?.signal || null;
      if (requestCount > 1) return response(syncWithTeam({ status: 0 }));
      return await new Promise((resolve) => {
        settleRequest = resolve;
      });
    },
    refreshTruth: async () => {
      refreshCount += 1;
      return syncWithTeam({ status: 0 });
    },
  });

  const first = await settleWithin(
    fixture.runner.handle(activeOrder(), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    }),
    "never-settling request server window",
  );
  await settleWithin(fixture.runner.flush(), "flush after server window");

  assert.equal(first.finalReason, "server-ended");
  assert.equal(requestCount, 2);
  assert.equal(refreshCount, 0);
  assert.equal(requestSignal?.aborted, false);

  const quarantined = await settleWithin(
    fixture.runner.handle(syncWithTeam({ status: 1 }), {
      trigger: "resident-order",
      config: fixtureRunnerConfig(),
    }),
    "quarantined follow-up",
  );
  assert.equal(quarantined.finalReason, "transport-in-doubt");
  assert.equal(requestCount, 2);
  assert.equal(refreshCount, 0);

  settleRequest(response(syncWithTeam({ status: 0 })));
  await Promise.resolve();
  await Promise.resolve();
  const afterSettle = await fixture.runner.handle(activeOrder({
    startTime: 2_000_000,
    activeTime: 2_000_125,
  }), {
    trigger: "new-challenge",
    config: fixtureRunnerConfig(),
  });
  assert.equal(afterSettle.finalReason, "server-ended");
  assert.equal(requestCount, 3);
});

test("a submit still pending at the real 50 second edge cannot block reward settlement", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const clock = { epochMs: 59_500, monotonicMs: 0, sleeps: [] };
  const requests = [];
  let settleSubmit;
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    clock,
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return await new Promise((resolve) => {
          settleSubmit = resolve;
        });
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await settleWithin(
    runner.handle(activeOrder(), {
      trigger: "last-submit-pending",
      config: fixtureRunnerConfig(),
    }),
    "settlement after a pending final submit",
  );

  assert.equal(result.finalReason, "server-ended");
  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.equal(archive.commit.length, 1);
  assert.deepEqual(
    archive.commit[0].events.map(({ action, status }) => [action, status]),
    [["submit", "pending"], ["settle", "success"]],
  );

  settleSubmit(response(activeOrder({ status: 3, orderNum: 2 })));
  await Promise.resolve();
  const idle = await runner.handle(syncWithTeam({ status: 0 }), {
    trigger: "after-late-submit",
    config: fixtureRunnerConfig(),
  });
  assert.equal(idle.finalReason, "idle");
  assert.equal(requests.length, 2);
  assert.equal(archive.commit.length, 1);
});

test("a final submit response changing orderNum restarts the reward animation before collection", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const clock = { epochMs: 59_500, monotonicMs: 0, sleeps: [] };
  let settleSubmit;
  let rewardRequestedAt = null;
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    clock,
    uiTimings: TEAM_ORDER_UI_TIMINGS,
    sleep: async (milliseconds) => {
      clock.sleeps.push(milliseconds);
      clock.monotonicMs += milliseconds;
      if (milliseconds === TEAM_ORDER_UI_TIMINGS.rewardReadyMs) {
        settleSubmit(response(activeOrder({
          status: 3,
          orderNum: 12,
          rwd: { 11: 1_000 },
        })));
        await Promise.resolve();
      }
    },
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return await new Promise((resolve) => {
          settleSubmit = resolve;
        });
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      rewardRequestedAt = clock.monotonicMs;
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await settleWithin(
    runner.handle(activeOrder(), {
      trigger: "late-submit-before-reward",
      config: fixtureRunnerConfig(),
    }),
    "late submit merge before reward",
  );

  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.submittedCount, 1);
  assert.equal(archive.commit.length, 1);
  assert.equal(archive.commit[0].result.finalOrderNum, 12);
  assert.equal(archive.commit[0].result.multiplier, 1.2);
  assert.deepEqual(archive.commit[0].result.reward.raw, { 11: 1_000 });
  assert.equal(
    clock.sleeps.filter(
      (milliseconds) => milliseconds === TEAM_ORDER_UI_TIMINGS.rewardReadyMs,
    ).length,
    2,
  );
  assert.equal(rewardRequestedAt, 3_100);
  assert.deepEqual(
    archive.commit[0].events.map(({ action, status }) => [action, status]),
    [["submit", "pending"], ["submit", "success"], ["settle", "success"]],
  );
});

test("a pending reward request yields the loop and is consumed later without duplicate collection", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let settleReward;
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      requests.push(iface);
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return await new Promise((resolve) => {
        settleReward = resolve;
      });
    },
  });
  const challenge = activeOrder({ status: 3, rwd: { 11: 75 } });

  const first = await settleWithin(
    runner.handle(challenge, {
      trigger: "reward-pending",
      config: fixtureRunnerConfig(),
    }),
    "first pending reward checkpoint",
  );
  assert.equal(first.finalReason, "settlement-pending");
  assert.equal(requests.length, 1);
  assert.equal(archive.commit.length, 0);

  const second = await settleWithin(
    runner.handle(challenge, {
      trigger: "reward-still-pending",
      config: fixtureRunnerConfig(),
    }),
    "second pending reward checkpoint",
  );
  assert.equal(second.finalReason, "settlement-pending");
  assert.equal(requests.length, 1);
  assert.equal(archive.commit.length, 0);

  settleReward(response(syncWithTeam({ status: 0 })));
  await Promise.resolve();
  await Promise.resolve();
  const completed = await settleWithin(
    runner.handle(challenge, {
      trigger: "reward-response-arrived",
      config: fixtureRunnerConfig(),
    }),
    "completed reward checkpoint",
  );

  assert.equal(completed.finalReason, "server-ended");
  assert.equal(requests.length, 1);
  assert.equal(archive.commit.length, 1);
  assert.deepEqual(
    archive.commit[0].events.map(({ action, status }) => [action, status]),
    [["settle", "pending"], ["settle", "success"]],
  );
});

test("events collected before a server archive time appears survive the pending reward handoff", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let settleReward;
  const { runner, archive, archiveIdentities } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.takeOrder) {
        return response(syncWithTeam({
          status: 2,
          orderNum: 1,
          flowerId: 23_001,
        }, { 23_001: 15 }));
      }
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(syncWithTeam({
          status: 2,
          orderNum: 2,
          flowerId: 23_002,
        }, { 23_002: 0 }));
      }
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        return response(syncWithTeam({
          status: 3,
          orderNum: 2,
          flowerId: 23_003,
          rwd: { 2: 310_135, 11: 222_930 },
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return await new Promise((resolve) => {
        settleReward = resolve;
      });
    },
  });

  const pending = await settleWithin(
    runner.handle(syncWithTeam({ status: 1 }), {
      trigger: "resident-order",
      config: fixtureRunnerConfig(),
      nobleExpAdd: 0,
    }),
    "pending reward without archive identity",
  );
  assert.equal(pending.finalReason, "settlement-pending");
  assert.equal(archive.commit.length, 0);
  assert.deepEqual(archiveIdentities, []);

  settleReward(response(syncWithTeam({ status: 0 })));
  await Promise.resolve();
  await Promise.resolve();
  const completed = await settleWithin(
    runner.handle(syncWithTeam({
      status: 3,
      orderNum: 2,
      flowerId: 23_003,
      cTime: "2026-07-27T10:31:05.747Z",
      rwd: { 2: 310_135, 11: 222_930 },
    }), {
      trigger: "reward-response-arrived",
      config: fixtureRunnerConfig(),
      nobleExpAdd: 0,
    }),
    "completed reward after archive identity appeared",
  );

  assert.equal(completed.finalReason, "server-ended");
  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.takeOrder,
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.equal(archive.commit.length, 1);
  assert.equal(archive.commit[0].initial.trigger, "resident-order");
  assert.equal(archive.commit[0].initial.initialOrderNum, 1);
  assert.deepEqual(
    archive.commit[0].events.map(({ action, status }) => [action, status]),
    [
      ["accept", "success"],
      ["submit", "success"],
      ["inventory-shortage", "failure"],
      ["refresh", "success"],
      ["settle", "pending"],
      ["settle", "success"],
    ],
  );
});

test("archive events survive when the same challenge upgrades from cTime to startTime", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let settleReward;
  const cTime = "2026-07-28T01:48:07.633Z";
  const startTime = "2026-07-28T01:48:08.000Z";
  const { runner, archive, archiveIdentities } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.takeOrder) {
        return response(syncWithTeam({
          status: 2,
          orderNum: 1,
          flowerId: 23_001,
          cTime,
        }, { 23_001: 15 }));
      }
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(syncWithTeam({
          status: 2,
          orderNum: 2,
          flowerId: 23_002,
          cTime,
        }, { 23_002: 0 }));
      }
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        return response(syncWithTeam({
          status: 3,
          orderNum: 2,
          flowerId: 23_003,
          cTime,
          rwd: { 2: 310_135, 11: 222_930 },
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return await new Promise((resolve) => {
        settleReward = resolve;
      });
    },
  });

  const pending = await settleWithin(
    runner.handle(syncWithTeam({ status: 1 }), {
      trigger: "resident-order",
      config: fixtureRunnerConfig(),
      nobleExpAdd: 0,
    }),
    "pending reward with fallback archive identity",
  );
  assert.equal(pending.finalReason, "settlement-pending");
  assert.equal(archive.commit.length, 0);
  assert.equal(archiveIdentities.length, 1);
  assert.equal(archiveIdentities[0].startTime, cTime);

  settleReward(response(syncWithTeam({ status: 0 })));
  await Promise.resolve();
  await Promise.resolve();
  const completed = await settleWithin(
    runner.handle(syncWithTeam({
      status: 3,
      orderNum: 2,
      flowerId: 23_003,
      startTime,
      cTime,
      rwd: { 2: 310_135, 11: 222_930 },
    }), {
      trigger: "reward-response-arrived",
      config: fixtureRunnerConfig(),
      nobleExpAdd: 0,
    }),
    "completed reward after archive identity upgrade",
  );

  assert.equal(completed.finalReason, "server-ended");
  assert.equal(archiveIdentities.length, 1);
  assert.equal(archive.commit.length, 1);
  assert.equal(archive.commit[0].initial.trigger, "resident-order");
  assert.equal(archive.commit[0].initial.initialOrderNum, 1);
  assert.deepEqual(
    archive.commit[0].events.map(({ action, status }) => [action, status]),
    [
      ["accept", "success"],
      ["submit", "success"],
      ["inventory-shortage", "failure"],
      ["refresh", "success"],
      ["settle", "pending"],
      ["settle", "success"],
    ],
  );
});

test("authoritative terminal sync finalizes a pending reward request without waiting or retrying", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let settleReward;
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      requests.push(iface);
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return await new Promise((resolve) => {
        settleReward = resolve;
      });
    },
  });
  const challenge = activeOrder({ status: 3, rwd: { 11: 75 } });

  const pending = await settleWithin(
    runner.handle(challenge, {
      trigger: "reward-pending",
      config: fixtureRunnerConfig(),
    }),
    "pending reward before authoritative sync",
  );
  assert.equal(pending.finalReason, "settlement-pending");

  const completed = await settleWithin(
    runner.handle(syncWithTeam({ status: 0 }), {
      trigger: "authoritative-terminal-sync",
      config: fixtureRunnerConfig(),
    }),
    "terminal sync finalization",
  );

  assert.equal(completed.finalReason, "server-ended");
  assert.equal(requests.length, 1);
  assert.equal(archive.commit.length, 1);
  assert.deepEqual(
    archive.commit[0].events.map(({ action, status, reason }) => [
      action,
      status,
      reason ?? null,
    ]),
    [
      ["settle", "pending", "request-pending"],
      ["settle", "success", "truth-confirmed"],
    ],
  );

  settleReward(response(syncWithTeam({ status: 0 })));
  await Promise.resolve();
  const idle = await runner.handle(syncWithTeam({ status: 0 }), {
    trigger: "late-reward-response",
    config: fixtureRunnerConfig(),
  });
  assert.equal(idle.finalReason, "idle");
  assert.equal(requests.length, 1);
});

test("requestStop aborts a never-settling request and lets handle plus flush finish", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let notifyStarted;
  let releaseFirstPoll;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const firstPoll = new Promise((resolve) => {
    releaseFirstPoll = resolve;
  });
  let requestCount = 0;
  let requestSignal = null;
  let sleepCount = 0;
  const { runner } = createFixtureRunner({
    clock,
    request: async (_iface, _args, _label, options) => {
      requestCount += 1;
      requestSignal = options?.signal || null;
      notifyStarted();
      return await new Promise(() => {});
    },
    sleep: async (milliseconds) => {
      clock.sleeps.push(milliseconds);
      clock.monotonicMs += milliseconds;
      sleepCount += 1;
      if (sleepCount === 1) await firstPoll;
    },
  });

  const handling = runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  await started;
  runner.requestStop("manual-stop");
  releaseFirstPoll();
  const [result] = await Promise.all([
    settleWithin(handling, "stopped never-settling request"),
    settleWithin(runner.flush(), "flush after requestStop"),
  ]);

  assert.equal(result.finalReason, "manual-stop");
  assert.equal(requestCount, 1);
  assert.equal(requestSignal?.aborted, true);
});

test("a truth refresh interrupted by WebSocket close remains in doubt without a client timeout", async () => {
  let requestCount = 0;
  let refreshCount = 0;
  const { runner } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      throw Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
    },
    refreshTruth: async () => {
      refreshCount += 1;
      throw new Error("WS closed while waiting for gs.usr.lazySync");
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  await runner.flush();

  assert.equal(result.finalReason, "result-in-doubt");
  assert.equal(requestCount, 1);
  assert.equal(refreshCount, 1);
});

test("same runner handle calls share one in-flight promise and flush waits for it", async () => {
  let releaseRequest;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      notifyStarted();
      await requestGate;
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const first = runner.handle(syncWithTeam({ status: 1 }), {
    trigger: "first",
    config: fixtureRunnerConfig(),
  });
  const second = runner.handle(syncWithTeam({ status: 3 }), {
    trigger: "second",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first, second);
  await started;

  let flushFinished = false;
  const flushing = runner.flush().then(() => {
    flushFinished = true;
  });
  await Promise.resolve();
  assert.equal(flushFinished, false);

  releaseRequest();
  await Promise.all([first, flushing]);
  assert.equal(requestCount, 1);
  assert.equal(flushFinished, true);
});

test("requestStop prevents the next request after the current response", async () => {
  let releaseRequest;
  let notifyStarted;
  const started = new Promise((resolve) => {
    notifyStarted = resolve;
  });
  const requestGate = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  let requestCount = 0;
  const { runner, archive } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      notifyStarted();
      await requestGate;
      return response(activeOrder({
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 15 },
      }));
    },
  });

  const handling = runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  await started;
  runner.requestStop("manual-stop");
  releaseRequest();
  const result = await handling;

  assert.equal(requestCount, 1);
  assert.equal(result.finalReason, "manual-stop");
  assert.equal(
    archive.append.filter((event) => event.action === "stop").length,
    1,
  );
});

test("an already aborted signal prevents every request and archives the stop", async () => {
  const controller = new AbortController();
  controller.abort();
  let requestCount = 0;
  const { runner, archive } = createFixtureRunner({
    signal: controller.signal,
    request: async () => {
      requestCount += 1;
      return response({});
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 0);
  assert.equal(result.finalReason, "aborted");
  assert.equal(archive.append.at(-1).action, "stop");
});

test("shouldStop is checked immediately before an action", async () => {
  let stopChecks = 0;
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    shouldStop: async () => {
      stopChecks += 1;
      return { reason: "stop-file" };
    },
    request: async () => {
      requestCount += 1;
      return response({});
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.ok(stopChecks >= 1);
  assert.equal(requestCount, 0);
  assert.equal(result.finalReason, "stop-file");
});

test("the client-compatible runner keeps submitting until the real 50 second edge", async () => {
  const requests = [];
  const { runner } = createFixtureRunner({
    clock: { epochMs: 49_500, monotonicMs: 0, sleeps: [] },
    request: async (iface) => {
      requests.push(iface);
      return iface === TEAM_ORDER_IFACES.submitOrder
        ? response(activeOrder({
            status: 3,
            startTime: 1_000,
            orderNum: 2,
            bag: { 23_001: 0 },
          }))
        : response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder({ startTime: 1_000 }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.equal(result.finalReason, "server-ended");
});

test("runner publishes account-scoped live status in memory and clears it after final archive", async () => {
  const liveStatuses = [];
  const { runner } = createFixtureRunner({
    onStatus(status) {
      liveStatuses.push(status);
    },
    request: async (iface) => (
      iface === TEAM_ORDER_IFACES.submitOrder
        ? response(activeOrder({
            status: 3,
            orderNum: 2,
            flowerId: 23_002,
            bag: { 23_002: 0 },
          }))
        : response(syncWithTeam({ status: 0 }))
    ),
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "resident-order-submitted",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  const active = liveStatuses.find((status) => (
    status?.active === true
    && status.submittedCount === 1
  ));
  assert.deepEqual({
    profileId: active?.profileId,
    uid: active?.uid,
    serverOrderNum: active?.serverOrderNum,
    completedOrderCount: active?.completedOrderCount,
    flowerId: active?.flowerId,
    need: active?.need,
    submittedCount: active?.submittedCount,
    refreshedCount: active?.refreshedCount,
    errorCount: active?.errorCount,
  }, {
    profileId: "p1",
    uid: "u1",
    serverOrderNum: 2,
    completedOrderCount: 1,
    flowerId: 23_002,
    need: 15,
    submittedCount: 1,
    refreshedCount: 0,
    errorCount: 0,
  });
  assert.equal(liveStatuses.at(-1), null);
});

test("inventory shortage increments refresh telemetry without becoming an error", async () => {
  const liveStatuses = [];
  const { runner } = createFixtureRunner({
    archiveFixture: createRecordingOneShotArchive(),
    onStatus(status) {
      liveStatuses.push(status);
    },
    request: async (iface) => (
      iface === TEAM_ORDER_IFACES.refreshOrder
        ? response(activeOrder({
            status: 3,
            orderNum: 1,
            flowerId: 23_002,
            bag: { 23_002: 0 },
          }))
        : response(syncWithTeam({ status: 0 }))
    ),
  });

  const result = await runner.handle(activeOrder({
    bag: { 23_001: 0 },
  }), {
    trigger: "inventory-shortage",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  const refreshed = liveStatuses.find((status) => (
    status?.active === true
    && status.refreshedCount === 1
  ));
  assert.deepEqual({
    refreshedCount: refreshed?.refreshedCount,
    inventoryShortageCount: refreshed?.inventoryShortageCount,
    errorCount: refreshed?.errorCount,
    lastError: refreshed?.lastError,
  }, {
    refreshedCount: 1,
    inventoryShortageCount: 1,
    errorCount: 0,
    lastError: null,
  });
});

test("runner does not report zero completed orders when the server order number is unknown", async () => {
  const liveStatuses = [];
  const { runner } = createFixtureRunner({
    onStatus(status) {
      liveStatuses.push(status);
    },
    request: async () => response(syncWithTeam({ status: 0 })),
  });

  await runner.handle(activeOrder({
    status: 1,
    orderNum: null,
  }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  const active = liveStatuses.find((status) => status?.active === true);
  assert.equal(active?.serverOrderNum, null);
  assert.equal(active?.completedOrderCount, null);
});

test("server deadline is converted once to monotonic time and wall-clock rollback cannot extend it", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let wallClockMs = 10_000;
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    clock,
    nowMs: () => wallClockMs,
    request: async (iface) => {
      requestCount += 1;
      if (iface === TEAM_ORDER_IFACES.recvRwd) {
        return response(syncWithTeam({ status: 0 }));
      }
      clock.monotonicMs = 50_000;
      wallClockMs = 0;
      return response(activeOrder({
        startTime: 30_000,
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 15 },
      }));
    },
  });

  const result = await runner.handle(activeOrder({ startTime: 10_000 }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 2);
  assert.equal(result.finalReason, "server-ended");
});

test("elapsed time beyond 55 seconds does not stop a challenge before its server deadline", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    clock,
    request: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        clock.monotonicMs += 55_000;
        return response(activeOrder({
          startTime: 1_000_000,
          orderNum: 2,
          flowerId: 23_002,
          bag: { 23_002: 15 },
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(
    activeOrder({ startTime: 1_000_000 }),
    { trigger: "startup", config: fixtureRunnerConfig() },
  );

  assert.equal(requestCount, 2);
  assert.equal(result.finalReason, "server-ended");
});

test("the 160th order can complete but an active order beyond 160 stops", async () => {
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      return response(activeOrder({
        orderNum: 161,
        flowerId: 23_002,
        bag: { 23_002: 15 },
      }));
    },
  });

  const result = await runner.handle(activeOrder({
    orderNum: 160,
    bag: { 23_001: 15 },
  }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 1);
  assert.equal(result.submittedCount, 1);
  assert.equal(result.finalReason, "order-max-reached");
});

test("rolling limiter delays the fifth refresh but never overlaps requests", async () => {
  const refreshTimes = [];
  let refreshCount = 0;
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const fixture = createFixtureRunner({
    request: async (iface) => {
      activeRequests += 1;
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
      try {
        if (iface === TEAM_ORDER_IFACES.refreshOrder) {
          refreshCount += 1;
          refreshTimes.push(fixture.clock.monotonicMs);
          if (refreshCount === 5) {
            return response(activeOrder({
              status: 3,
              flowerId: 23_006,
              bag: {},
            }));
          }
          return response(activeOrder({
            flowerId: 23_001 + refreshCount,
            bag: {},
          }));
        }
        return response(syncWithTeam({ status: 0 }));
      } finally {
        activeRequests -= 1;
      }
    },
  });

  const result = await fixture.runner.handle(activeOrder({ bag: {} }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(refreshTimes.slice(0, 4), [0, 0, 0, 0]);
  assert.ok(refreshTimes[4] >= 1_000);
  assert.deepEqual(fixture.clock.sleeps, [1_000]);
  assert.equal(maximumActiveRequests, 1);
  assert.equal(result.refreshedCount, 5);
});

test("submit requests are response-driven and are not throttled to four per second", async () => {
  const submitTimes = [];
  const fixture = createFixtureRunner({
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitTimes.push(fixture.clock.monotonicMs);
        const nextOrderNum = submitTimes.length + 1;
        if (submitTimes.length === 5) {
          return response(activeOrder({
            status: 3,
            orderNum: 5,
          }));
        }
        return response(activeOrder({
          orderNum: nextOrderNum,
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await fixture.runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(submitTimes, [0, 0, 0, 0, 0]);
  assert.deepEqual(fixture.clock.sleeps, []);
  assert.equal(result.submittedCount, 5);
});

test("request limit stops after exactly 400 serial requests", async () => {
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      const even = requestCount % 2 === 0;
      return response(activeOrder({
        flowerId: even ? 23_001 : 23_002,
        bag: { 23_001: 15, 23_002: 15 },
        remainingNum: even ? 0 : 1,
      }));
    },
  });

  const result = await runner.handle(activeOrder({
    bag: { 23_001: 15, 23_002: 15 },
    remainingNum: 0,
  }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxRequests);
  assert.equal(result.finalReason, "request-limit");
});

test("unknown status degrades only this feature and records a failure", async () => {
  let requestCount = 0;
  const { runner, archive } = createFixtureRunner({
    request: async () => {
      requestCount += 1;
      return response({});
    },
  });

  const result = await runner.handle(syncWithTeam({
    status: 99,
    startTime: 6_000,
    activeTime: 6_125,
  }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 0);
  assert.equal(result.finalReason, "unknown-status");
  assert.equal(archive.append.at(-1).action, "failure");
});

test("active team submit and pending reward ignore ordinary experience guard", async () => {
  let requestCount = 0;
  let guardChecks = 0;
  for (const syncValue of [activeOrder(), syncWithTeam({ status: 3 })]) {
    const { runner } = createFixtureRunner({
      getExperienceGuard: () => {
        guardChecks += 1;
        return {
          blocked: true,
          reasonText: "experience threshold",
        };
      },
      request: async () => {
        requestCount += 1;
        return response(syncWithTeam({ status: 0 }));
      },
    });
    const result = await runner.handle(syncValue, {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });
    assert.notEqual(result.finalReason, "experience-guard");
  }
  assert.equal(requestCount, 2);
  assert.equal(guardChecks, 0);
});

test("archive receives each business event and always finishes then flushes", async () => {
  let submitCount = 0;
  const { runner, archive } = createFixtureRunner({
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.takeOrder) {
        return response(activeOrder());
      }
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        return response(activeOrder({
          orderNum: 2,
          flowerId: 23_002,
          bag: { 23_002: 0 },
        }));
      }
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          flowerId: 23_003,
          bag: {},
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(syncWithTeam({
    status: 1,
    startTime: 5_000,
    activeTime: 5_125,
  }), {
    trigger: "resident-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(submitCount, 1);
  assert.deepEqual(
    archive.append.map((event) => event.action),
    ["accept", "submit", "inventory-shortage", "refresh", "settle"],
  );
  assert.equal(
    archive.append.find((event) => event.action === "submit")?.flowerConsumed,
    15,
  );
  assert.equal(archive.start.length, 1);
  assert.equal(archive.finish.length, 1);
  assert.equal(archive.flush, 1);
  assert.equal(archive.finish[0].finalOrderNum, 2);
  assert.equal(result.actionCount, 4);
  assert.deepEqual(result.capability, { ready: true });
});

test("submit and reward settlement follow the real UI interaction delays", async () => {
  const requests = [];
  const { runner, clock } = createFixtureRunner({
    uiTimings: TEAM_ORDER_UI_TIMINGS,
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          bag: { 23_001: 0 },
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "ui-timing",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  assert.deepEqual(clock.sleeps, [200, 300, 1_300]);
});

test("official gateway action lock is not duplicated by the runner", async () => {
  const { runner, clock } = createFixtureRunner({
    officialTeamOrderActionLockHandled: true,
    uiTimings: TEAM_ORDER_UI_TIMINGS,
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          bag: { 23_001: 0 },
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "official-action-lock",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.deepEqual(clock.sleeps, [200, 1_300]);
});

test("one-shot archive buffers challenge events and commits only after settlement", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder({ status: 3 }), {
    trigger: "server-ended",
    config: fixtureRunnerConfig(),
    nobleExpAdd: 0,
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(archive.start.length, 0);
  assert.equal(archive.append.length, 0);
  assert.equal(archive.finish.length, 0);
  assert.equal(archive.flush, 0);
  assert.equal(archive.commit.length, 1);
  assert.deepEqual(
    archive.commit[0].events.map((event) => event.action),
    ["settle"],
  );
  assert.equal(archive.commit[0].result.finalStatus, "completed");
  assert.equal(archive.commit[0].result.multiplier, 1);
  assert.equal(
    archive.commit[0].result.reward.calculated.displayed[11],
    10_000,
  );
  assert.deepEqual(archive.commit[0].result.reward.items, [
    {
      itemId: 2,
      itemName: "经验",
      rawAmount: 0,
      displayedAmount: 8_000,
    },
    {
      itemId: 11,
      itemName: "金币",
      rawAmount: 0,
      displayedAmount: 10_000,
    },
  ]);
  assert.equal(
    archive.commit[0].result.reward.displayText,
    "经验 8000；金币 1,0000",
  );
});

test("archive finish and flush failures never block completed business", async () => {
  for (const failedMethod of ["finish", "flush"]) {
    const archiveFixture = createRecordingArchive({
      [failedMethod]: async () => {
        throw new Error(`${failedMethod} failed`);
      },
    });
    let requestCount = 0;
    const { runner, archive } = createFixtureRunner({
      archiveFixture,
      request: async () => {
        requestCount += 1;
        return response(syncWithTeam({ status: 0 }));
      },
    });

    const result = await runner.handle(syncWithTeam({
      status: 1,
      startTime: 5_000,
      activeTime: 5_125,
    }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });

    assert.equal(requestCount, 1, failedMethod);
    assert.equal(result.handled, true, failedMethod);
    assert.equal(result.finalReason, "server-ended", failedMethod);
    assert.equal(archive.start.length, 1, failedMethod);
    assert.ok(archive.append.length >= 1, failedMethod);
    assert.equal(archive.finish.length, 1, failedMethod);
    assert.equal(archive.flush, 1, failedMethod);
  }
});

test("production archive deadline ignores a backward-moving Date.now clock", async () => {
  const oldNow = Date.now;
  let dateNowCalls = 0;
  Date.now = () => {
    dateNowCalls += 1;
    return 10_000 - (dateNowCalls * 1_000);
  };

  try {
    const { runner, archive } = createFixtureRunner({
      useProductionArchiveClock: true,
      request: async () => response(syncWithTeam({ status: 0 })),
    });

    const result = await runner.handle(syncWithTeam({
      status: 1,
      startTime: 5_000,
      activeTime: 5_125,
    }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });

    assert.equal(result.finalReason, "server-ended");
    assert.equal(archive.start.length, 1);
    assert.equal(archive.finish.length, 1);
    assert.equal(archive.flush, 1);
    assert.equal(dateNowCalls, 0);
  } finally {
    Date.now = oldNow;
  }
});

test("archive start or append pending cannot consume the final submit window", async () => {
  async function runScenario(pendingMethod = null) {
    let activeArchiveCalls = 0;
    let maximumActiveArchiveCalls = 0;
    let rejectPending;
    const pending = new Promise((_, reject) => {
      rejectPending = reject;
    });
    const archiveFixture = createRecordingArchive(
      Object.fromEntries(
        ["start", "append", "finish", "flush"].map((method) => [
          method,
          async () => {
            activeArchiveCalls += 1;
            maximumActiveArchiveCalls = Math.max(
              maximumActiveArchiveCalls,
              activeArchiveCalls,
            );
            try {
              if (method === pendingMethod) await pending;
            } finally {
              activeArchiveCalls -= 1;
            }
          },
        ]),
      ),
    );
    const requests = [];
    const fixture = createFixtureRunner({
      archiveFixture,
      clock: { epochMs: 47_500, monotonicMs: 0, sleeps: [] },
      request: async (iface, args) => {
        requests.push({ iface, args });
        return response(syncWithTeam({ status: 0 }));
      },
    });

    const result = await settleWithin(
      fixture.runner.handle(activeOrder({
        startTime: 0,
        activeTime: 125,
      }), {
        trigger: "startup",
        config: fixtureRunnerConfig(),
      }),
      `business with ${pendingMethod || "normal"} archive`,
    );
    await settleWithin(
      fixture.runner.flush(),
      `flush with ${pendingMethod || "normal"} archive`,
    );

    if (pendingMethod) {
      rejectPending(new Error(`late ${pendingMethod} rejection`));
      await new Promise((resolve) => setImmediate(resolve));
    }

    return {
      result,
      requests,
      archiveCalls: archiveFixture.calls,
      maximumActiveArchiveCalls,
      activeArchiveCalls,
    };
  }

  const normal = await runScenario();
  const pendingStart = await runScenario("start");
  const pendingAppend = await runScenario("append");
  const expectedRequest = [{
    iface: TEAM_ORDER_IFACES.submitOrder,
    args: {},
  }];

  assert.deepEqual(normal.requests, expectedRequest);
  assert.equal(normal.result.finalReason, "server-ended");
  assert.equal(normal.archiveCalls.finish.length, 1);
  assert.equal(normal.archiveCalls.flush, 1);

  for (const pending of [pendingStart, pendingAppend]) {
    assert.deepEqual(pending.requests, normal.requests);
    assert.equal(pending.result.finalReason, normal.result.finalReason);
    assert.equal(pending.maximumActiveArchiveCalls, 1);
    assert.equal(pending.activeArchiveCalls, 0);
  }
});

for (const pendingMethod of ["start", "append", "finish", "flush"]) {
  test(`a never-settling archive ${pendingMethod} call is bounded and quarantines later archive calls`, async () => {
    let activeArchiveCalls = 0;
    let maximumActiveArchiveCalls = 0;
    const overrides = {};
    for (const method of ["start", "append", "finish", "flush"]) {
      overrides[method] = async () => {
        activeArchiveCalls += 1;
        maximumActiveArchiveCalls = Math.max(
          maximumActiveArchiveCalls,
          activeArchiveCalls,
        );
        if (method === pendingMethod) {
          return await new Promise(() => {});
        }
        activeArchiveCalls -= 1;
      };
    }
    const archiveFixture = createRecordingArchive(overrides);
    let requestCount = 0;
    const fixture = createFixtureRunner({
      archiveFixture,
      request: async () => {
        requestCount += 1;
        return response(syncWithTeam({ status: 0 }));
      },
    });

    const result = await settleWithin(
      fixture.runner.handle(syncWithTeam({
        status: 1,
        startTime: 5_000,
        activeTime: 5_125,
      }), {
        trigger: "startup",
        config: fixtureRunnerConfig(),
      }),
      `pending archive ${pendingMethod}`,
    );
    await settleWithin(
      fixture.runner.flush(),
      `flush after pending archive ${pendingMethod}`,
    );

    const expectedCalls = {
      start: { start: 1, append: 0, finish: 0, flush: 0 },
      append: { start: 1, append: 1, finish: 0, flush: 0 },
      finish: { start: 1, append: 1, finish: 1, flush: 0 },
      flush: { start: 1, append: 1, finish: 1, flush: 1 },
    }[pendingMethod];
    assert.equal(requestCount, 1);
    assert.equal(result.finalReason, "server-ended");
    assert.equal(archiveFixture.calls.start.length, expectedCalls.start);
    assert.equal(archiveFixture.calls.append.length, expectedCalls.append);
    assert.equal(archiveFixture.calls.finish.length, expectedCalls.finish);
    assert.equal(archiveFixture.calls.flush, expectedCalls.flush);
    assert.equal(maximumActiveArchiveCalls, 1);
  });
}

test("a one-shot archive failure is isolated after business completion without extra file writes", async () => {
  await withTempDir("team-order-runner-start-retry-", async (statusDir) => {
    let failNextJsonRename = true;
    let jsonRenameAttempts = 0;
    const identity = {
      profileId: "p1",
      uid: "u1",
      startTime: 5_000,
      activeTime: 5_125,
    };
    const runId = createTeamOrderRunId(identity);
    const jsonPath = path.join(statusDir, "team-orders", `${runId}.json`);
    const fileSystem = {
      ...fs,
      async rename(fromPath, toPath) {
        if (toPath.endsWith(".json")) {
          jsonRenameAttempts += 1;
          if (failNextJsonRename) {
            failNextJsonRename = false;
            throw Object.assign(new Error("simulated transient start failure"), {
              code: "EBUSY",
            });
          }
        }
        return fs.rename(fromPath, toPath);
      },
    };
    const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
    const archiveClock = { monotonicMs: 0, sleeps: [] };
    const { runner } = createFixtureRunner({
      clock,
      archiveClock,
      createArchive(archiveIdentity) {
        return createTeamOrderArchive({
          statusDir,
          ...archiveIdentity,
          label: "测试账号",
          serverIdx: 1,
          runId: createTeamOrderRunId(archiveIdentity),
          fileSystem,
        });
      },
      request: async () => response(syncWithTeam({ status: 0 })),
      sleep: async (milliseconds) => {
        clock.sleeps.push(milliseconds);
        clock.monotonicMs += milliseconds;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      archiveSleep: async (milliseconds) => {
        archiveClock.sleeps.push(milliseconds);
        archiveClock.monotonicMs += 1;
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
    });

    const result = await runner.handle(syncWithTeam({
      status: 1,
      ...identity,
    }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });
    await runner.flush();

    assert.equal(jsonRenameAttempts, 1);
    await assert.rejects(fs.access(jsonPath));
    assert.deepEqual(result.archiveErrors, [{
      method: "commit",
      kind: "error",
      message: "simulated transient start failure",
    }]);
    assert.equal(result.finalReason, "server-ended");
  });
});

test("startTime alone is sufficient for a stable one-shot archive identity", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const fixture = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0 }));
    },
  });
  const syncValue = syncWithTeam({
    status: 3,
    startTime: 42_000,
    orderNum: 7,
    flowerId: 23_001,
  });

  const first = await fixture.runner.handle(syncValue, {
    trigger: "start-time-only",
    config: fixtureRunnerConfig(),
  });

  assert.equal(first.finalReason, "server-ended");
  assert.equal(fixture.archiveIdentities.length, 1);
  assert.equal(fixture.archiveIdentities[0].startTime, 42_000);
  assert.equal(fixture.archive.commit.length, 1);
});

test("real client activeTime or cTime preserves an archive when startTime is absent", async () => {
  for (const [field, value] of [
    ["activeTime", "2026-07-27T09:50:00.000Z"],
    ["cTime", "2026-07-27T09:49:59.000Z"],
  ]) {
    const archiveFixture = createRecordingOneShotArchive();
    const fixture = createFixtureRunner({
      archiveFixture,
      request: async (iface) => {
        assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
        return response(syncWithTeam({ status: 0 }));
      },
    });
    const syncValue = syncWithTeam({
      status: 3,
      startTime: null,
      [field]: value,
      orderNum: 7,
      flowerId: 23_001,
    });

    const result = await fixture.runner.handle(syncValue, {
      trigger: `client-${field}`,
      config: fixtureRunnerConfig(),
    });

    assert.equal(result.finalReason, "server-ended");
    assert.equal(fixture.archiveIdentities.length, 1, field);
    assert.equal(fixture.archiveIdentities[0].startTime, value, field);
    assert.equal(fixture.archive.commit.length, 1, field);
  }
});

test("confirmed unchanged submit callbacks still wait 300ms and continue", async () => {
  let submitCount = 0;
  const { runner, clock } = createFixtureRunner({
    uiTimings: TEAM_ORDER_UI_TIMINGS,
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        if (submitCount === 1) return response(activeOrder());
        return response(activeOrder({ status: 3, orderNum: 2 }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "unchanged-success",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(submitCount, 2);
  assert.deepEqual(clock.sleeps, [200, 300, 300, 1_300]);
});

test("confirmed unchanged callbacks do not end a valid challenge after eight responses", async () => {
  let submitCount = 0;
  const { runner } = createFixtureRunner({
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        if (submitCount <= 9) return response(activeOrder());
        return response(activeOrder({ status: 3, orderNum: 2 }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "no-same-state-stop",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(submitCount, 10);
});

test("ordinary submit rejection refreshes truth and continues without a hot loop", async () => {
  let submitCount = 0;
  let truthRefreshCount = 0;
  const { runner, clock, archive } = createFixtureRunner({
    uiTimings: TEAM_ORDER_UI_TIMINGS,
    refreshTruth: async (syncValue) => {
      truthRefreshCount += 1;
      return syncValue;
    },
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        if (submitCount === 1) {
          return { value: {}, dsName: "ORDER_BUSY", errMsg: "订单处理中" };
        }
        return response(activeOrder({ status: 3, orderNum: 2 }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "business-rejection",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(submitCount, 2);
  assert.equal(truthRefreshCount, 1);
  assert.equal(clock.sleeps.includes(300), true);
  assert.equal(
    archive.append.some((event) => event.status === "server-rejected"),
    true,
  );
});

test("confirmed submit deducts sparse inventory before the same flower appears again", async () => {
  const config = fixtureRunnerConfig();
  config.orders.set(1, {
    orderNum: 1,
    flowerNum: 60,
    magnification: 100,
  });
  config.orders.set(2, {
    orderNum: 2,
    flowerNum: 80,
    magnification: 100,
  });
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          orderNum: 2,
          flowerId: 23_090,
          bag: {},
        }));
      }
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          flowerId: 23_090,
          bag: {},
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder({
    flowerId: 23_090,
    bag: { 23_090: 109 },
  }), {
    trigger: "same-flower-sparse-inventory",
    config,
  });

  assert.equal(result.finalReason, "server-ended");
  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  const submitted = archive.append.find((event) => event.action === "submit");
  const shortage = archive.append.find(
    (event) => event.action === "inventory-shortage",
  );
  assert.equal(submitted.inventoryBefore, 109);
  assert.equal(submitted.inventoryAfter, 49);
  assert.equal(shortage.inventoryBefore, 49);
  assert.equal(shortage.need, 80);
});

test("sparse inventory deduction survives intervening orders before the flower repeats", async () => {
  const config = fixtureRunnerConfig();
  config.orders.set(36, {
    orderNum: 36,
    flowerNum: 45,
    magnification: 100,
  });
  config.orders.set(43, {
    orderNum: 43,
    flowerNum: 60,
    magnification: 100,
  });
  let submitCount = 0;
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        if (submitCount === 1) {
          return response(activeOrder({
            orderNum: 37,
            flowerId: 23_001,
            bag: {},
          }));
        }
        return response(activeOrder({
          orderNum: 43,
          flowerId: 23_567,
          bag: {},
        }));
      }
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 43,
          flowerId: 23_567,
          bag: {},
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder({
    orderNum: 36,
    flowerId: 23_567,
    bag: { 23_001: 15, 23_567: 61 },
  }), {
    trigger: "repeated-flower-after-intervening-order",
    config,
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(submitCount, 2);
  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  const shortage = archive.append.find(
    (event) => event.action === "inventory-shortage",
  );
  assert.equal(shortage.flowerId, 23_567);
  assert.equal(shortage.inventoryBefore, 16);
  assert.equal(shortage.need, 60);
});

test("submit code 301 becomes inventory shortage and refreshes instead of retrying", async () => {
  let submitCount = 0;
  let truthRefreshCount = 0;
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    refreshTruth: async (syncValue) => {
      truthRefreshCount += 1;
      return syncValue;
    },
    request: async (iface) => {
      requests.push(iface);
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        if (submitCount === 1) {
          return {
            value: null,
            dsName: "G.ISyncData",
            errMsg: { code: 301, param: { iid: 23_001 } },
          };
        }
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          bag: { 23_001: 14 },
        }));
      }
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 1,
          bag: { 23_001: 14 },
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "submit-inventory-rejection",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(submitCount, 1);
  assert.equal(truthRefreshCount, 0);
  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.recvRwd,
  ]);
  const rejected = archive.append.find(
    (event) => event.status === "server-rejected",
  );
  assert.deepEqual(rejected.error, {
    code: 301,
    param: { iid: 23_001 },
    schema: "G.ISyncData",
  });
  assert.equal(
    archive.append.some((event) => event.action === "inventory-shortage"),
    true,
  );
});

test("refresh fixed window starts with dialog initialization instead of after 200ms", async () => {
  let refreshCount = 0;
  const { runner, clock } = createFixtureRunner({
    uiTimings: {
      dialogReadyMs: 200,
      nextActionMs: 0,
      rewardReadyMs: 0,
    },
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.refreshOrder) {
        refreshCount += 1;
        if (refreshCount === 5) {
          return response(activeOrder({
            status: 3,
            orderNum: 2,
            flowerId: 23_010,
            bag: {},
          }));
        }
        return response(activeOrder({
          flowerId: 23_001 + refreshCount,
          bag: {},
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder({ bag: {} }), {
    trigger: "refresh-window-anchor",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.equal(refreshCount, 5);
  assert.deepEqual(clock.sleeps, [200, 800]);
});

test("maximum order completion waits 600ms before the 1300ms reward animation", async () => {
  const { runner, clock } = createFixtureRunner({
    uiTimings: TEAM_ORDER_UI_TIMINGS,
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 160,
          bag: { 23_001: 0 },
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder({ orderNum: 159 }), {
    trigger: "maximum-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(result.finalReason, "server-ended");
  assert.deepEqual(clock.sleeps, [200, 600, 1_300]);
});

test("terminal archive separates server order number from displayed completed count", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async () => response(syncWithTeam({ status: 0 })),
  });

  await runner.handle(activeOrder({ status: 3, orderNum: 12 }), {
    trigger: "completed-count",
    config: fixtureRunnerConfig(),
  });

  assert.equal(archive.commit.length, 1);
  assert.equal(archive.commit[0].result.serverOrderNum, 12);
  assert.equal(archive.commit[0].result.completedOrderCount, 11);
  assert.equal(archive.commit[0].result.finalOrderNum, 12);
});

test("direct status 3 entry honors the finish dialog cantBuy flag", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface, args) => {
      requests.push({ iface, args });
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam({ status: 0, remainingNum: 2 }));
    },
  });

  await runner.handle(activeOrder({ status: 3, orderNum: 12 }), {
    trigger: "paid-renew-skip",
    config: fixtureRunnerConfig(),
    getPaidRenewProtectionEnabled: () => false,
  });

  assert.deepEqual(requests, [{ iface: TEAM_ORDER_IFACES.recvRwd, args: {} }]);
  assert.equal(
    archive.commit[0].events.some((event) => (
      event.action === "paid-renew-skipped" && event.status === "skipped"
    )),
    false,
  );
  assert.equal(archive.commit[0].result.paidRenewAvailable, false);
  assert.equal(archive.commit[0].result.paidRenewSkipped, false);
});

test("challenge completion declines a protected paid renewal with the official non-purchase tuple", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          bag: { 23_001: 0 },
        }));
      }
      if (iface === TEAM_ORDER_IFACES.recvRwd) {
        return response(syncWithTeam({ status: 0, remainingNum: 2 }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.takeOrder);
      assert.deepEqual(args, { isAgree: false, isCost: true });
      return response(syncWithTeam({ status: 0, remainingNum: 2 }));
    },
  });

  await runner.handle(activeOrder(), {
    trigger: "paid-renew-skip",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests, [
    { iface: TEAM_ORDER_IFACES.submitOrder, args: {} },
    { iface: TEAM_ORDER_IFACES.recvRwd, args: {} },
    {
      iface: TEAM_ORDER_IFACES.takeOrder,
      args: { isAgree: false, isCost: true },
    },
  ]);
  assert.equal(
    archive.commit[0].events.some((event) => (
      event.action === "paid-renew-skipped" && event.status === "skipped"
    )),
    true,
  );
  assert.equal(archive.commit[0].result.paidRenewAvailable, true);
  assert.equal(archive.commit[0].result.paidRenewSkipped, true);
});

test("paid renewal reads the latest disabled protection value, pays once, and completes the renewed challenge", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let protectionReads = 0;
  let experienceGuardReads = 0;
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (iface === TEAM_ORDER_IFACES.submitOrder && requests.length === 1) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          remainingNum: 1,
          bag: { 1: 0, 23_001: 0 },
          dmd: 120,
        }));
      }
      if (iface === TEAM_ORDER_IFACES.recvRwd && requests.length === 2) {
        return response(syncWithTeam(
          { status: 0, remainingNum: 1 },
          { 1: 0 },
          { dmd: 120 },
        ));
      }
      if (iface === TEAM_ORDER_IFACES.takeOrder) {
        return response(activeOrder({
          status: 2,
          startTime: 20_000,
          orderNum: 1,
          remainingNum: 0,
          bag: { 1: 0, 23_001: 15 },
          dmd: 60,
        }));
      }
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          startTime: 20_000,
          orderNum: 2,
          remainingNum: 0,
          bag: { 1: 0, 23_001: 0 },
          dmd: 60,
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      return response(syncWithTeam(
        { status: 0, remainingNum: 0 },
        { 1: 0 },
        { dmd: 60 },
      ));
    },
  });

  const context = {
    trigger: "paid-renew-success",
    config: fixtureRunnerConfig(),
    capability: {
      ready: true,
      teamOrderPaidRenewProtectionEnabled: true,
    },
    getPaidRenewProtectionEnabled() {
      protectionReads += 1;
      return false;
    },
    getPaidRenewExperienceGuard() {
      experienceGuardReads += 1;
      return { blocked: false };
    },
  };
  const ordinary = await runner.handle(activeOrder({
    remainingNum: 1,
    bag: { 1: 0, 23_001: 15 },
    dmd: 120,
  }), context);
  const result = await runner.handle(ordinary.syncValue, context);

  const paidRequests = requests.filter(({ args }) => args?.isCost === true);
  assert.equal(protectionReads, 1);
  assert.equal(experienceGuardReads, 1);
  assert.deepEqual(paidRequests, [{
    iface: TEAM_ORDER_IFACES.takeOrder,
    args: { isAgree: true, isCost: true },
  }]);
  assert.equal(ordinary.finalReason, "paid-renew-continued");
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.submittedCount, 1);
  assert.equal(result.paidRenewPurchasedCount, 1);
  assert.equal(result.paidRenewConfirmedCost, 60);
  const paidEvent = archive.commit[1].events.find(
    (event) => event.action === "paid-renew" && event.status === "success",
  );
  assert.deepEqual({
    costItemId: paidEvent.costItemId,
    costAmount: paidEvent.costAmount,
    balanceBefore: paidEvent.balanceBefore,
    balanceAfter: paidEvent.balanceAfter,
    remainingNumBefore: paidEvent.remainingNumBefore,
    remainingNumAfter: paidEvent.remainingNumAfter,
    confirmationEvidence: paidEvent.confirmationEvidence,
    serverConfirmed: paidEvent.serverConfirmed,
  }, {
    costItemId: 1,
    costAmount: 60,
    balanceBefore: 120,
    balanceAfter: 60,
    remainingNumBefore: 1,
    remainingNumAfter: 0,
    confirmationEvidence: [
      "remaining-num-decreased",
      "yuanbao-cost-debited",
    ],
    serverConfirmed: true,
  });
  assert.equal(archive.commit[0].result.paidRenewPurchasedCount, 0);
  assert.equal(archive.commit[0].result.paidRenewConfirmedCost, 0);
  assert.equal(archive.commit[1].result.paidRenewPurchasedCount, 1);
  assert.equal(archive.commit[1].result.paidRenewConfirmedCost, 60);
});

test("paid renewal writes the renewed challenge as a separate archive with its own reward", async () => {
  await withTempDir("team-order-paid-renew-split-", async (statusDir) => {
    const identities = [];
    let submitCount = 0;
    let settlementCount = 0;
    let settleRenewedReward;
    const fixture = createFixtureRunner({
      useProductionArchiveClock: true,
      createArchive(identity) {
        identities.push(identity);
        return createTeamOrderArchive({
          statusDir,
          ...identity,
          label: "测试账号",
          serverIdx: 1,
          runId: createTeamOrderRunId(identity),
        });
      },
      request: async (iface, args) => {
        if (iface === TEAM_ORDER_IFACES.submitOrder) {
          submitCount += 1;
          return response(activeOrder({
            status: 3,
            startTime: submitCount === 1 ? 10_000 : 20_000,
            orderNum: 2,
            remainingNum: submitCount === 1 ? 1 : 0,
            rwd: submitCount === 1
              ? { 2: 100, 11: 200 }
              : { 2: 300, 11: 400 },
            bag: { 23_001: 0 },
            dmd: submitCount === 1 ? 120 : 60,
          }));
        }
        if (iface === TEAM_ORDER_IFACES.recvRwd) {
          settlementCount += 1;
          if (settlementCount === 1) {
            return response(syncWithTeam(
              { status: 0, remainingNum: 1 },
              {},
              { dmd: 120 },
            ));
          }
          return await new Promise((resolve) => {
            settleRenewedReward = resolve;
          });
        }
        assert.equal(iface, TEAM_ORDER_IFACES.takeOrder);
        assert.deepEqual(args, { isAgree: true, isCost: true });
        return response(activeOrder({
          status: 2,
          startTime: 20_000,
          orderNum: 1,
          remainingNum: 0,
          bag: { 23_001: 15 },
          dmd: 60,
        }));
      },
    });
    const context = {
      trigger: "paid-renew-split",
      config: fixtureRunnerConfig(),
      nobleExpAdd: 0,
      getPaidRenewProtectionEnabled: () => false,
      experienceGuard: { blocked: false },
    };

    const ordinary = await fixture.runner.handle(activeOrder({
      remainingNum: 1,
      bag: { 23_001: 15 },
      dmd: 120,
    }), context);

    assert.equal(ordinary.finalReason, "paid-renew-continued");
    assert.equal(identities.length, 1);

    const renewedPending = await fixture.runner.handle(
      ordinary.syncValue,
      context,
    );
    assert.equal(renewedPending.finalReason, "settlement-pending");
    assert.equal(identities.length, 2);

    settleRenewedReward(response(syncWithTeam(
      { status: 0, remainingNum: 0 },
      {},
      { dmd: 60 },
    )));
    await Promise.resolve();
    await Promise.resolve();
    const renewed = await fixture.runner.handle(
      renewedPending.syncValue,
      context,
    );
    await fixture.runner.flush();

    assert.equal(renewed.finalReason, "server-ended");
    assert.deepEqual(
      identities.map((identity) => identity.startTime),
      [10_000, 20_000],
    );
    const archiveFiles = await fs.readdir(path.join(statusDir, "team-orders"));
    const jsonFiles = archiveFiles.filter((name) => name.endsWith(".json"));
    assert.equal(jsonFiles.length, 2, JSON.stringify({
      identities,
      archiveFiles,
      ordinaryArchiveErrors: ordinary.archiveErrors,
      renewedArchiveErrors: renewed.archiveErrors,
    }));
    const ledgers = (await Promise.all(jsonFiles.map(async (name) => (
      JSON.parse(await fs.readFile(
        path.join(statusDir, "team-orders", name),
        "utf8",
      ))
    )))).sort((left, right) => (
      Date.parse(left.startedAt) - Date.parse(right.startedAt)
    ));
    assert.equal(new Set(ledgers.map((ledger) => ledger.runId)).size, 2);
    assert.deepEqual(
      ledgers.map((ledger) => ledger.events.map((event) => event.action)),
      [
        ["submit", "settle"],
        ["paid-renew", "submit", "settle", "settle"],
      ],
    );
    assert.deepEqual(
      ledgers.map((ledger) => ledger.reward.calculated.displayed),
      [
        { 2: 8_100, 11: 10_200 },
        { 2: 8_300, 11: 10_400 },
      ],
    );
    assert.deepEqual(
      ledgers.map((ledger) => ({
        paidRenew: ledger.paidRenew,
        count: ledger.paidRenewPurchasedCount,
        cost: ledger.paidRenewConfirmedCost,
      })),
      [
        { paidRenew: false, count: 0, cost: 0 },
        { paidRenew: true, count: 1, cost: 60 },
      ],
    );
  });
});

test("paid renewal accepts either a remaining-count decrease or the configured yuanbao debit as confirmation", async () => {
  const cases = [
    {
      name: "remaining-count",
      remainingNumAfter: 0,
      balanceAfter: 120,
      evidence: ["remaining-num-decreased"],
    },
    {
      name: "yuanbao-debit",
      remainingNumAfter: 1,
      balanceAfter: 60,
      evidence: ["yuanbao-cost-debited"],
    },
  ];

  for (const scenario of cases) {
    const archiveFixture = createRecordingOneShotArchive();
    let paidRequestSent = false;
    let submitCount = 0;
    const { runner, archive } = createFixtureRunner({
      archiveFixture,
      request: async (iface, args) => {
        if (iface === TEAM_ORDER_IFACES.submitOrder) {
          submitCount += 1;
          return response(activeOrder({
            status: 3,
            startTime: submitCount === 1 ? 10_000 : 20_000,
            orderNum: 2,
            remainingNum: paidRequestSent ? scenario.remainingNumAfter : 1,
            bag: { 23_001: 0 },
            dmd: paidRequestSent ? scenario.balanceAfter : 120,
          }));
        }
        if (iface === TEAM_ORDER_IFACES.recvRwd) {
          return response(syncWithTeam(
            {
              status: 0,
              remainingNum: paidRequestSent ? scenario.remainingNumAfter : 1,
            },
            {},
            { dmd: paidRequestSent ? scenario.balanceAfter : 120 },
          ));
        }
        assert.equal(iface, TEAM_ORDER_IFACES.takeOrder);
        assert.deepEqual(args, { isAgree: true, isCost: true });
        paidRequestSent = true;
        return response(activeOrder({
          status: 2,
          startTime: 20_000,
          orderNum: 1,
          remainingNum: scenario.remainingNumAfter,
          bag: { 23_001: 15 },
          dmd: scenario.balanceAfter,
        }));
      },
    });

    const context = {
      trigger: `paid-renew-evidence-${scenario.name}`,
      config: fixtureRunnerConfig(),
      getPaidRenewProtectionEnabled: () => false,
      experienceGuard: { blocked: false },
    };
    const ordinary = await runner.handle(activeOrder({
      remainingNum: 1,
      bag: { 23_001: 15 },
      dmd: 120,
    }), context);
    const result = await runner.handle(ordinary.syncValue, context);

    assert.equal(ordinary.finalReason, "paid-renew-continued", scenario.name);
    assert.equal(result.finalReason, "server-ended", scenario.name);
    assert.equal(result.paidRenewPurchasedCount, 1, scenario.name);
    const paidEvent = archive.commit[1].events.find(
      (event) => event.action === "paid-renew" && event.status === "success",
    );
    assert.deepEqual(
      paidEvent.confirmationEvidence,
      scenario.evidence,
      scenario.name,
    );
  }
});

test("paid renewal never counts an active status without count or yuanbao evidence", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let submitCount = 0;
  let refreshCount = 0;
  const unprovenActive = activeOrder({
    status: 2,
    startTime: 20_000,
    orderNum: 1,
    remainingNum: 1,
    bag: { 23_001: 15 },
    dmd: 120,
  });
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        submitCount += 1;
        return response(activeOrder({
          status: 3,
          startTime: submitCount === 1 ? 10_000 : 20_000,
          orderNum: 2,
          remainingNum: 1,
          bag: { 23_001: 0 },
          dmd: 120,
        }));
      }
      if (iface === TEAM_ORDER_IFACES.recvRwd) {
        return response(syncWithTeam(
          { status: 0, remainingNum: 1 },
          {},
          { dmd: 120 },
        ));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.takeOrder);
      assert.deepEqual(args, { isAgree: true, isCost: true });
      return response(unprovenActive);
    },
    refreshTruth: async () => {
      refreshCount += 1;
      return unprovenActive;
    },
  });

  const result = await runner.handle(activeOrder({
    remainingNum: 1,
    bag: { 23_001: 15 },
    dmd: 120,
  }), {
    trigger: "paid-renew-unproven-active",
    config: fixtureRunnerConfig(),
    getPaidRenewProtectionEnabled: () => false,
    experienceGuard: { blocked: false },
  });

  const resumed = await runner.handle(result.syncValue, {
    trigger: "paid-renew-unproven-active-resumed",
    config: fixtureRunnerConfig(),
    getPaidRenewProtectionEnabled: () => false,
    experienceGuard: { blocked: false },
  });

  assert.equal(refreshCount, 1);
  assert.equal(
    requests.filter(({ args }) => (
      args?.isAgree === true && args?.isCost === true
    )).length,
    1,
  );
  assert.equal(result.finalReason, "paid-renew-result-unknown");
  assert.equal(result.paidRenewPurchasedCount, 0);
  assert.equal(result.paidRenewConfirmedCost, 0);
  assert.equal(resumed.paidRenewPurchasedCount, 0);
  const unknownEvent = archive.commit[0].events.find(
    (event) => event.reason === "paid-renew-result-unknown",
  );
  assert.deepEqual({
    balanceBefore: unknownEvent.balanceBefore,
    balanceAfter: unknownEvent.balanceAfter,
    remainingNumBefore: unknownEvent.remainingNumBefore,
    remainingNumAfter: unknownEvent.remainingNumAfter,
    confirmationEvidence: unknownEvent.confirmationEvidence,
    serverConfirmed: unknownEvent.serverConfirmed,
  }, {
    balanceBefore: 120,
    balanceAfter: 120,
    remainingNumBefore: 1,
    remainingNumAfter: 1,
    confirmationEvidence: [],
    serverConfirmed: false,
  });
});

test("paid renewal fails closed before payment for protection, balance, config, and experience guards", async () => {
  const cases = [
    {
      name: "protection",
      protectionEnabled: true,
      dmd: 120,
      config: fixtureRunnerConfig(),
      experienceGuard: { blocked: false },
      reason: "paid-renew-protection-enabled",
    },
    {
      name: "balance",
      protectionEnabled: false,
      dmd: 59,
      config: fixtureRunnerConfig(),
      experienceGuard: { blocked: false },
      reason: "insufficient-yuanbao",
    },
    {
      name: "config",
      protectionEnabled: false,
      dmd: 120,
      config: { ...fixtureRunnerConfig(), paidRenewCost: [2, 60] },
      experienceGuard: { blocked: false },
      reason: "invalid-paid-renew-config",
    },
    {
      name: "experience",
      protectionEnabled: false,
      dmd: 120,
      config: fixtureRunnerConfig(),
      experienceGuard: { blocked: true },
      reason: "experience-guard",
    },
  ];

  for (const scenario of cases) {
    const archiveFixture = createRecordingOneShotArchive();
    const requests = [];
    const { runner, archive } = createFixtureRunner({
      archiveFixture,
      request: async (iface, args) => {
        requests.push({ iface, args });
        if (iface === TEAM_ORDER_IFACES.submitOrder) {
          return response(activeOrder({
            status: 3,
            orderNum: 2,
            remainingNum: 1,
            bag: { 23_001: 0 },
            dmd: scenario.dmd,
          }));
        }
        if (iface === TEAM_ORDER_IFACES.recvRwd) {
          return response(syncWithTeam(
            { status: 0, remainingNum: 1 },
            {},
            { dmd: scenario.dmd },
          ));
        }
        assert.equal(iface, TEAM_ORDER_IFACES.takeOrder);
        assert.deepEqual(args, { isAgree: false, isCost: true });
        return response(syncWithTeam(
          { status: 0, remainingNum: 1 },
          {},
          { dmd: scenario.dmd },
        ));
      },
    });

    const result = await runner.handle(activeOrder({
      remainingNum: 1,
      bag: { 23_001: 15 },
      dmd: scenario.dmd,
    }), {
      trigger: `paid-renew-${scenario.name}`,
      config: scenario.config,
      getPaidRenewProtectionEnabled: () => scenario.protectionEnabled,
      experienceGuard: scenario.experienceGuard,
    });

    const declineRequests = requests.filter(({ args }) => (
      args?.isAgree === false && args?.isCost === true
    ));
    const purchaseRequests = requests.filter(({ args }) => (
      args?.isAgree === true && args?.isCost === true
    ));
    assert.equal(declineRequests.length, 1, scenario.name);
    assert.equal(purchaseRequests.length, 0, scenario.name);
    assert.equal(result.paidRenewPurchasedCount, 0, scenario.name);
    assert.equal(
      archive.commit[0].events.some((event) => event.reason === scenario.reason),
      true,
      scenario.name,
    );
  }
});

test("an official paid renewal decline is never retried after a transport failure", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          remainingNum: 1,
          bag: { 23_001: 0 },
          dmd: 120,
        }));
      }
      if (iface === TEAM_ORDER_IFACES.recvRwd) {
        return response(syncWithTeam(
          { status: 0, remainingNum: 1 },
          {},
          { dmd: 120 },
        ));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.takeOrder);
      assert.deepEqual(args, { isAgree: false, isCost: true });
      throw new Error("decline transport lost");
    },
  });

  const result = await runner.handle(activeOrder({
    remainingNum: 1,
    bag: { 23_001: 15 },
    dmd: 120,
  }), {
    trigger: "paid-renew-decline-error",
    config: fixtureRunnerConfig(),
    getPaidRenewProtectionEnabled: () => true,
  });

  assert.equal(
    requests.filter(({ args }) => (
      args?.isAgree === false && args?.isCost === true
    )).length,
    1,
  );
  assert.equal(
    requests.some(({ args }) => (
      args?.isAgree === true && args?.isCost === true
    )),
    false,
  );
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.paidRenewPurchasedCount, 0);
  const skipEvent = archive.commit[0].events.find(
    (event) => event.action === "paid-renew-skipped",
  );
  assert.equal(skipEvent.serverConfirmed, false);
  assert.match(skipEvent.error.message, /decline transport lost/);
});

test("an official paid renewal decline preserves structured server rejection details", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({ status: 3, orderNum: 2, remainingNum: 1 }));
      }
      if (iface === TEAM_ORDER_IFACES.recvRwd) {
        return response(syncWithTeam({ status: 0, remainingNum: 1 }));
      }
      return {
        value: null,
        dsName: "G.ISyncData",
        errMsg: { code: 301, param: { iid: 23_567 } },
      };
    },
  });

  await runner.handle(activeOrder({ remainingNum: 1 }), {
    trigger: "paid-renew-decline-structured-error",
    config: fixtureRunnerConfig(),
    getPaidRenewProtectionEnabled: () => true,
  });

  const skipEvent = archive.commit[0].events.find(
    (event) => event.action === "paid-renew-skipped",
  );
  assert.deepEqual(skipEvent.error, {
    code: 301,
    param: { iid: 23_567 },
    schema: "G.ISyncData",
  });
  assert.equal(JSON.stringify(skipEvent).includes("[object Object]"), false);
});

test("paid renewal rejection and unknown result each send at most one paid request", async () => {
  for (const mode of ["rejected", "unknown"]) {
    const archiveFixture = createRecordingOneShotArchive();
    const requests = [];
    let refreshCount = 0;
    const terminal = syncWithTeam(
      { status: 0, remainingNum: 1 },
      { 1: 120 },
    );
    const { runner, archive } = createFixtureRunner({
      archiveFixture,
      request: async (iface, args) => {
        requests.push({ iface, args });
        if (iface === TEAM_ORDER_IFACES.submitOrder) {
          return response(activeOrder({
            status: 3,
            orderNum: 2,
            remainingNum: 1,
            bag: { 1: 120, 23_001: 0 },
          }));
        }
        if (iface === TEAM_ORDER_IFACES.recvRwd) return response(terminal);
        if (mode === "rejected") {
          return { value: null, dsName: "NOT_ALLOWED", errMsg: "rejected" };
        }
        throw new Error("paid request transport lost");
      },
      refreshTruth: async () => {
        refreshCount += 1;
        return terminal;
      },
    });

    const result = await runner.handle(activeOrder({
      remainingNum: 1,
      bag: { 1: 120, 23_001: 15 },
    }), {
      trigger: `paid-renew-${mode}`,
      config: fixtureRunnerConfig(),
      getPaidRenewProtectionEnabled: () => false,
      experienceGuard: { blocked: false },
    });

    assert.equal(
      requests.filter(({ args }) => args?.isCost === true).length,
      1,
      mode,
    );
    assert.equal(result.paidRenewPurchasedCount, 0, mode);
    assert.equal(refreshCount, mode === "unknown" ? 1 : 0, mode);
    assert.equal(
      archive.commit[0].events.some((event) => (
        event.action === "paid-renew"
        && event.reason === (
          mode === "rejected"
            ? "paid-renew-server-rejected"
            : "paid-renew-result-unknown"
        )
      )),
      true,
      mode,
    );
  }
});

test("paid renewal and settlement preserve structured server rejection details", async () => {
  for (const mode of ["paid-renew", "settlement"]) {
    const archiveFixture = mode === "paid-renew"
      ? createRecordingOneShotArchive()
      : createRecordingArchive();
    const { runner, archive } = createFixtureRunner({
      archiveFixture,
      request: async (iface) => {
        if (mode === "settlement" && iface === TEAM_ORDER_IFACES.recvRwd) {
          return {
            value: null,
            dsName: "G.ISyncData",
            errMsg: { code: 301, param: { iid: 23_567 } },
          };
        }
        if (iface === TEAM_ORDER_IFACES.submitOrder) {
          return response(activeOrder({ status: 3, orderNum: 2, remainingNum: 1 }));
        }
        if (iface === TEAM_ORDER_IFACES.recvRwd) {
          return response(syncWithTeam({ status: 0, remainingNum: 1 }, { 1: 120 }));
        }
        return {
          value: null,
          dsName: "G.ISyncData",
          errMsg: { code: 301, param: { iid: 23_567 } },
        };
      },
    });

    await runner.handle(
      mode === "settlement"
        ? syncWithTeam({ status: 3, startTime: 10, expireTime: 60 })
        : activeOrder({ remainingNum: 1, bag: { 1: 120, 23_001: 15 } }),
      {
        trigger: `${mode}-structured-error`,
        config: fixtureRunnerConfig(),
        getPaidRenewProtectionEnabled: () => false,
        experienceGuard: { blocked: false },
      },
    );

    const events = [
      ...archive.append,
      ...(archive.commit || []).flatMap((entry) => entry.events || []),
    ];
    const rejected = events.find(
      (event) => event.status === "server-rejected",
    );
    assert.deepEqual(rejected.error, {
      code: 301,
      param: { iid: 23_567 },
      schema: "G.ISyncData",
    }, mode);
    assert.equal(JSON.stringify(rejected).includes("[object Object]"), false, mode);
  }
});

test("a stop observed after reward settlement prevents the paid renewal request", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const requests = [];
  let stopped = false;
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    shouldStop: async () => (stopped ? { reason: "user-stop" } : null),
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (iface === TEAM_ORDER_IFACES.submitOrder) {
        return response(activeOrder({
          status: 3,
          orderNum: 2,
          remainingNum: 1,
          bag: { 1: 120, 23_001: 0 },
        }));
      }
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      stopped = true;
      return response(syncWithTeam(
        { status: 0, remainingNum: 1 },
        { 1: 120 },
      ));
    },
  });

  const result = await runner.handle(activeOrder({
    remainingNum: 1,
    bag: { 1: 120, 23_001: 15 },
  }), {
    trigger: "paid-renew-stop",
    config: fixtureRunnerConfig(),
    getPaidRenewProtectionEnabled: () => false,
    experienceGuard: { blocked: false },
  });

  assert.equal(requests.some(({ args }) => args?.isCost === true), false);
  assert.equal(result.finalReason, "user-stop");
  assert.equal(result.paidRenewPurchasedCount, 0);
  assert.equal(
    archive.commit[0].events.some((event) => (
      event.action === "stop" && event.reason === "user-stop"
    )),
    true,
  );
});

test("blank and invalid stable server times never create an archive identity", async () => {
  const invalidTimes = [
    null,
    undefined,
    "",
    "   ",
    Number.NaN,
    new Date(Number.NaN),
    "not-a-server-time",
  ];
  for (const invalidTime of invalidTimes) {
    const fixture = createFixtureRunner();
    await fixture.runner.handle(syncWithTeam({
      status: 99,
      startTime: invalidTime,
      activeTime: invalidTime,
      cTime: invalidTime,
    }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });
    assert.deepEqual(
      fixture.archiveIdentities,
      [],
      `unexpected archive identity for ${String(invalidTime)}`,
    );
  }
});

test("zero, Date, ISO, second, and millisecond server times remain valid archive identity values", async () => {
  const validTimePairs = [
    [0, 0],
    [new Date("2026-07-24T00:00:00.000Z"), new Date("2026-07-24T00:00:01.000Z")],
    ["2026-07-24T00:00:00.000Z", "2026-07-24T00:00:01.000Z"],
    [1_721_779_200, 1_721_779_201],
    [1_721_779_200_000, 1_721_779_201_000],
  ];
  for (const [startTime, activeTime] of validTimePairs) {
    const fixture = createFixtureRunner();
    await fixture.runner.handle(syncWithTeam({
      status: 99,
      startTime,
      activeTime,
    }), {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });
    assert.equal(fixture.archiveIdentities.length, 1);
    assert.equal(fixture.archiveIdentities[0].startTime, startTime);
    assert.equal(fixture.archiveIdentities[0].activeTime, activeTime);
  }
});

test("sparse submit response reselects the next mutation from refreshed truth", async () => {
  const requests = [];
  const requestTimes = [];
  let refreshCount = 0;
  const fixture = createFixtureRunner({
    createArchive: () => null,
    request: async (iface) => {
      requests.push(iface);
      requestTimes.push(fixture.clock.monotonicMs);
      if (requests.length === 1) {
        return response({
          orderTeamTot: { orderTeam: {} },
          $usrTot: { data: { bag: { 23_001: 0 } } },
        });
      }
      return response(syncWithTeam({ status: 0 }));
    },
    refreshTruth: async () => {
      refreshCount += 1;
      return activeOrder({
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 0 },
      });
    },
    uiTimings: {
      dialogReadyMs: 0,
      nextActionMs: 300,
      rewardReadyMs: 0,
    },
  });

  const result = await fixture.runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.refreshOrder,
  ]);
  assert.deepEqual(requestTimes, [0, 300]);
  assert.equal(refreshCount, 1);
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.syncValue.orderTeamTot.orderTeam.orderNum, 2);
});

test("truth-confirmed sparse submit archives success without a timeout failure", async () => {
  const archiveFixture = createRecordingOneShotArchive();
  const { runner, archive } = createFixtureRunner({
    archiveFixture,
    request: async (iface) => {
      assert.equal(iface, TEAM_ORDER_IFACES.submitOrder);
      return response({
        orderTeamTot: { orderTeam: {} },
        $usrTot: { data: { bag: { 23_001: 0 } } },
      });
    },
    refreshTruth: async () => syncWithTeam({ status: 0 }),
    uiTimings: {
      dialogReadyMs: 0,
      nextActionMs: 0,
      rewardReadyMs: 0,
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "sparse-submit-telemetry",
    config: fixtureRunnerConfig(),
  });

  const events = archive.commit[0].events;
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.submittedCount, 1);
  assert.deepEqual(
    events
      .filter((event) => event.action === "submit")
      .map(({ status, reason = null }) => ({ status, reason })),
    [{ status: "success", reason: "truth-confirmed" }],
  );
  assert.equal(events.some((event) => event.action === "failure"), false);
});

test("sparse refresh response reselects the next mutation from refreshed truth", async () => {
  const requests = [];
  const requestTimes = [];
  let refreshCount = 0;
  const fixture = createFixtureRunner({
    createArchive: () => null,
    request: async (iface) => {
      requests.push(iface);
      requestTimes.push(fixture.clock.monotonicMs);
      if (requests.length === 1) {
        return response({
          orderTeamTot: { orderTeam: {} },
          $usrTot: { data: { bag: { 23_001: 1 } } },
        });
      }
      return response(syncWithTeam({ status: 0 }));
    },
    refreshTruth: async () => {
      refreshCount += 1;
      return activeOrder({
        orderNum: 1,
        flowerId: 23_002,
        bag: { 23_002: 0 },
      });
    },
    uiTimings: {
      dialogReadyMs: 0,
      nextActionMs: 300,
      rewardReadyMs: 0,
    },
  });

  const result = await fixture.runner.handle(activeOrder({ bag: {} }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.deepEqual(requests, [
    TEAM_ORDER_IFACES.refreshOrder,
    TEAM_ORDER_IFACES.refreshOrder,
  ]);
  assert.deepEqual(requestTimes, [0, 300]);
  assert.equal(refreshCount, 1);
  assert.equal(result.finalReason, "server-ended");
  assert.equal(result.syncValue.orderTeamTot.orderTeam.flowerId, 23_002);
});

test("cross-handle refresh limiter keeps at most four refreshes in one rolling second", async () => {
  const refreshTimes = [];
  const fixture = createFixtureRunner({
    createArchive: () => null,
    request: async (iface) => {
      assert.equal(iface, TEAM_ORDER_IFACES.refreshOrder);
      refreshTimes.push(fixture.clock.monotonicMs);
      return { value: null, dsName: null, errMsg: null };
    },
    refreshTruth: async () => activeOrder({ bag: {} }),
  });

  for (let index = 0; index < 5; index += 1) {
    const result = await fixture.runner.handle(activeOrder({ bag: {} }), {
      trigger: `checkpoint-${index}`,
      config: fixtureRunnerConfig(),
    });
    assert.equal(result.finalReason, "request-timeout-resynced");
  }

  assert.deepEqual(refreshTimes.slice(0, 4), [0, 0, 0, 0]);
  assert.ok(refreshTimes[4] >= 1_000);
});

test("cross-handle request budget stops the same challenge at 400 total mutations", async () => {
  let requestCount = 0;
  let mutationsThisHandle = 0;
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      mutationsThisHandle += 1;
      return response(activeOrder({
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 15 },
      }));
    },
    shouldStop: async () => (
      mutationsThisHandle > 0 ? { reason: "checkpoint-deferred" } : null
    ),
  });

  let result = null;
  for (let index = 0; index <= TEAM_ORDER_LIMITS.maxRequests; index += 1) {
    mutationsThisHandle = 0;
    result = await runner.handle(activeOrder(), {
      trigger: `checkpoint-${index}`,
      config: fixtureRunnerConfig(),
    });
  }

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxRequests);
  assert.equal(result.finalReason, "request-limit");
});

test("cross-handle unknown-result budget stops after eight unchanged truth refreshes", async () => {
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      throw Object.assign(new Error("result unknown"), {
        code: "ETIMEDOUT",
      });
    },
    refreshTruth: async () => activeOrder(),
  });

  let result = null;
  for (let index = 0; index < TEAM_ORDER_LIMITS.maxUnknownState; index += 1) {
    result = await runner.handle(activeOrder(), {
      trigger: `checkpoint-${index}`,
      config: fixtureRunnerConfig(),
    });
  }

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxUnknownState);
  assert.equal(result.finalReason, "unknown-state-limit");

  const afterLimit = await runner.handle(activeOrder(), {
    trigger: "checkpoint-after-limit",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxUnknownState);
  assert.equal(afterLimit.finalReason, "unknown-state-limit");
});

test("confirmed unchanged pending responses do not consume the unknown-result budget", async () => {
  let requestCount = 0;
  const pendingChallenge = syncWithTeam({ status: 1 });
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      return response(pendingChallenge);
    },
  });

  let result = null;
  for (let index = 0; index <= TEAM_ORDER_LIMITS.maxUnknownState; index += 1) {
    result = await runner.handle(pendingChallenge, {
      trigger: `pending-checkpoint-${index}`,
      config: fixtureRunnerConfig(),
    });
  }

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxUnknownState + 1);
  assert.equal(result.finalReason, "accept-unconfirmed");
});

test("no-time stored challenge is not stopped by an invented elapsed-time deadline", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let requestCount = 0;
  const storedChallenge = syncWithTeam({
    status: 0,
    storedOrders: [{ npcId: 999, expireTime: 120_000 }],
  });
  const { runner } = createFixtureRunner({
    clock,
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      return response(storedChallenge);
    },
  });

  const first = await runner.handle(storedChallenge, {
    trigger: "stored-startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "server-ended");

  clock.monotonicMs = 55_000;
  const second = await runner.handle(storedChallenge, {
    trigger: "stored-after-deadline",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 2);
  assert.equal(second.finalReason, "server-ended");
});

test("confirmed unchanged stored restores do not consume the unknown-result budget", async () => {
  let requestCount = 0;
  const storedChallenge = syncWithTeam({
    status: 0,
    storedOrders: [{ npcId: 999, expireTime: 120_000 }],
  });
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      return response(storedChallenge);
    },
  });

  let result = null;
  for (let index = 0; index <= TEAM_ORDER_LIMITS.maxUnknownState; index += 1) {
    result = await runner.handle(storedChallenge, {
      trigger: `stored-checkpoint-${index}`,
      config: fixtureRunnerConfig(),
    });
  }

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxUnknownState + 1);
  assert.equal(result.finalReason, "server-ended");
});

test("cross-handle challenge continues after 55 seconds when the server deadline is still open", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let requestCount = 0;
  let mutationsThisHandle = 0;
  const { runner } = createFixtureRunner({
    clock,
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      mutationsThisHandle += 1;
      if (requestCount === 1) {
        return response(activeOrder({
          startTime: 1_000_000,
          orderNum: 2,
          flowerId: 23_002,
          bag: { 23_002: 15 },
        }));
      }
      return response(syncWithTeam({ status: 0 }));
    },
    shouldStop: async () => (
      mutationsThisHandle > 0 ? { reason: "checkpoint-deferred" } : null
    ),
  });

  const first = await runner.handle(activeOrder({ startTime: 1_000_000 }), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "checkpoint-deferred");

  mutationsThisHandle = 0;
  clock.monotonicMs = 55_000;
  const second = await runner.handle(first.syncValue, {
    trigger: "ordinary-order",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 2);
  assert.equal(second.finalReason, "checkpoint-deferred");
});

test("result-in-doubt retries truth refresh after 55 seconds without inventing a terminal timeout", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let requestCount = 0;
  let refreshCount = 0;
  const timeout = Object.assign(new Error("submit result unknown"), {
    code: "ETIMEDOUT",
  });
  const { runner } = createFixtureRunner({
    clock,
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      throw timeout;
    },
    refreshTruth: async () => {
      refreshCount += 1;
      throw Object.assign(new Error("truth unavailable"), {
        code: "ETIMEDOUT",
      });
    },
  });

  const first = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "result-in-doubt");

  clock.monotonicMs = 55_000;
  const second = await runner.handle(activeOrder(), {
    trigger: "after-deadline",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 1);
  assert.equal(refreshCount, 2);
  assert.equal(second.finalReason, "result-in-doubt");
});

test("unresolved result-in-doubt yields to a proven new stable challenge", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let requestCount = 0;
  let refreshCount = 0;
  const timeout = Object.assign(new Error("submit result unknown"), {
    code: "ETIMEDOUT",
  });
  const { runner } = createFixtureRunner({
    clock,
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      if (requestCount === 1) throw timeout;
      return response(syncWithTeam({ status: 0 }));
    },
    refreshTruth: async () => {
      refreshCount += 1;
      throw Object.assign(new Error("truth unavailable"), {
        code: "ETIMEDOUT",
      });
    },
  });

  const oldChallenge = activeOrder({
    startTime: 10_000,
    activeTime: 10_125,
  });
  const first = await runner.handle(oldChallenge, {
    trigger: "old-startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "result-in-doubt");

  const newChallenge = activeOrder({
    startTime: 2_000_000,
    activeTime: 2_000_125,
  });
  const recovered = await runner.handle(newChallenge, {
    trigger: "new-challenge",
    config: fixtureRunnerConfig(),
  });

  assert.equal(recovered.finalReason, "server-ended");
  assert.equal(requestCount, 2);
  assert.equal(refreshCount, 1);
});

test("unresolved result-in-doubt yields to a genuine terminal input", async () => {
  const clock = { epochMs: 10_000, monotonicMs: 0, sleeps: [] };
  let requestCount = 0;
  let refreshCount = 0;
  const timeout = Object.assign(new Error("submit result unknown"), {
    code: "ETIMEDOUT",
  });
  const { runner } = createFixtureRunner({
    clock,
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      throw timeout;
    },
    refreshTruth: async () => {
      refreshCount += 1;
      throw Object.assign(new Error("truth unavailable"), {
        code: "ETIMEDOUT",
      });
    },
  });

  const oldChallenge = activeOrder();
  const first = await runner.handle(oldChallenge, {
    trigger: "old-startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "result-in-doubt");

  const terminal = await runner.handle(syncWithTeam({ status: 0 }), {
    trigger: "terminal",
    config: fixtureRunnerConfig(),
  });

  assert.equal(terminal.handled, false);
  assert.equal(terminal.finalReason, "idle");
  assert.equal(requestCount, 1);
  assert.equal(refreshCount, 1);
});

test("failed truth refresh keeps the challenge in doubt until a later truth refresh succeeds", async () => {
  let requestCount = 0;
  let refreshCount = 0;
  const timeout = Object.assign(new Error("submit result unknown"), {
    code: "ETIMEDOUT",
  });
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async () => {
      requestCount += 1;
      if (requestCount === 1) throw timeout;
      return response(syncWithTeam({ status: 0 }));
    },
    refreshTruth: async () => {
      refreshCount += 1;
      if (refreshCount <= 2) {
        throw Object.assign(new Error("truth unavailable"), {
          code: "ETIMEDOUT",
        });
      }
      return activeOrder({
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 15 },
      });
    },
  });

  const first = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "result-in-doubt");

  const second = await runner.handle(activeOrder(), {
    trigger: "special-order",
    config: fixtureRunnerConfig(),
  });
  assert.equal(second.finalReason, "result-in-doubt");
  assert.equal(requestCount, 1);
  assert.equal(refreshCount, 2);

  const third = await runner.handle(activeOrder(), {
    trigger: "ordinary-order",
    config: fixtureRunnerConfig(),
  });
  assert.equal(refreshCount, 3);
  assert.equal(requestCount, 2);
  assert.equal(third.finalReason, "server-ended");
});

test("result-in-doubt recovery reselects the next action from refreshed truth", async () => {
  const requests = [];
  let refreshCount = 0;
  const timeout = Object.assign(new Error("submit result unknown"), {
    code: "ETIMEDOUT",
  });
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async (iface, args) => {
      requests.push({ iface, args });
      if (requests.length === 1) throw timeout;
      return response(syncWithTeam({ status: 0 }));
    },
    refreshTruth: async () => {
      refreshCount += 1;
      if (refreshCount === 1) {
        throw Object.assign(new Error("truth unavailable"), {
          code: "ETIMEDOUT",
        });
      }
      return activeOrder({
        orderNum: 2,
        flowerId: 23_002,
        bag: { 23_002: 15 },
      });
    },
  });

  const first = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "result-in-doubt");

  const staleStoredInput = syncWithTeam({
    status: 0,
    storedOrders: [{ npcId: 999, expireTime: 120_000 }],
  });
  const second = await runner.handle(staleStoredInput, {
    trigger: "recovery",
    config: fixtureRunnerConfig(),
  });

  assert.equal(second.finalReason, "server-ended");
  assert.deepEqual(requests.map(({ iface }) => iface), [
    TEAM_ORDER_IFACES.submitOrder,
    TEAM_ORDER_IFACES.submitOrder,
  ]);
  assert.equal(
    requests.some(({ iface, args }) => (
      iface === TEAM_ORDER_IFACES.takeStoredOrder
      && args?.npcId === 999
    )),
    false,
  );
});

test("confirmed unchanged settlements do not consume the unknown-result budget", async () => {
  let requestCount = 0;
  const settlementChallenge = activeOrder({ status: 3 });
  const { runner } = createFixtureRunner({
    createArchive: () => null,
    request: async (iface) => {
      assert.equal(iface, TEAM_ORDER_IFACES.recvRwd);
      requestCount += 1;
      return response(settlementChallenge);
    },
  });

  let result = null;
  for (let index = 0; index <= TEAM_ORDER_LIMITS.maxUnknownState; index += 1) {
    result = await runner.handle(settlementChallenge, {
      trigger: `settlement-checkpoint-${index}`,
      config: fixtureRunnerConfig(),
    });
  }

  assert.equal(requestCount, TEAM_ORDER_LIMITS.maxUnknownState + 1);
  assert.equal(result.finalReason, "settlement-unconfirmed");
});

test("an active team order completes instead of finalizing the legacy archive as protected", async () => {
  const clock = {
    epochMs: 10_000,
    monotonicMs: 0,
    sleeps: [],
  };
  const fixture = createFixtureRunner({
    clock,
    getExperienceGuard: () => ({
      blocked: true,
      reasonText: "test protection",
    }),
    request: async () => response(syncWithTeam({ status: 0 })),
  });
  const identity = {
    startTime: 10_000,
    activeTime: 10_125,
  };

  const first = await fixture.runner.handle(activeOrder(identity), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  assert.equal(first.finalReason, "server-ended");
  assert.equal(fixture.archive.finish.length, 1);
  assert.equal(fixture.archive.finish[0].finalStatus, "completed");
  assert.equal(fixture.archive.finish[0].stopReason, "server-ended");
});

test("one-shot archive records an active team order completion exactly once", async () => {
  await withTempDir("team-order-runner-recoverable-stop-", async (statusDir) => {
    const identity = {
      profileId: "p1",
      uid: "u1",
      startTime: 5_000,
      activeTime: 5_125,
    };
    const runId = createTeamOrderRunId(identity);
    const { runner } = createFixtureRunner({
      useProductionArchiveClock: true,
      getExperienceGuard: () => ({
        blocked: true,
        reasonText: "test protection",
      }),
      request: async () => response(syncWithTeam({ status: 0 })),
      createArchive(archiveIdentity) {
        return createTeamOrderArchive({
          statusDir,
          ...archiveIdentity,
          runId: createTeamOrderRunId(archiveIdentity),
          label: "测试账号",
          serverIdx: 1,
        });
      },
    });
    const syncValue = activeOrder({
      startTime: identity.startTime,
      activeTime: identity.activeTime,
    });

    const first = await runner.handle(syncValue, {
      trigger: "startup",
      config: fixtureRunnerConfig(),
    });
    await runner.flush();
    assert.equal(first.finalReason, "server-ended");

    const jsonPath = path.join(statusDir, "team-orders", `${runId}.json`);
    const ledger = JSON.parse(await fs.readFile(jsonPath, "utf8"));
    const htmlPath = path.join(statusDir, "team-orders", ledger.htmlFile);
    await fs.access(htmlPath);
    assert.ok(ledger.finishedAt);
    assert.equal(ledger.finalStatus, "completed");
    assert.equal(ledger.stopReason, "server-ended");

    const files = await fs.readdir(path.join(statusDir, "team-orders"));
    assert.equal(files.filter((name) => name === `${runId}.json`).length, 1);
    assert.equal(
      files.filter((name) => name.endsWith(`-${runId}.html`)).length,
      1,
    );
  });
});

test("next mutation waits for the preceding business event JSON append", async () => {
  let releaseAppend;
  let notifyAppendStarted;
  const appendStarted = new Promise((resolve) => {
    notifyAppendStarted = resolve;
  });
  const appendGate = new Promise((resolve) => {
    releaseAppend = resolve;
  });
  const archiveFixture = createRecordingArchive({
    append: async () => {
      notifyAppendStarted();
      await appendGate;
    },
  });
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    archiveFixture,
    request: async () => {
      requestCount += 1;
      return requestCount === 1
        ? response(activeOrder({
            orderNum: 2,
            flowerId: 23_002,
            bag: { 23_002: 15 },
          }))
        : response(syncWithTeam({ status: 0 }));
    },
  });

  const handling = runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });
  await appendStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestCount, 1);

  releaseAppend();
  const result = await handling;
  assert.equal(requestCount, 2);
  assert.equal(result.finalReason, "server-ended");
});

test("persistent archive start failure is bounded and isolated before the next mutation", async () => {
  const archiveFixture = createRecordingArchive({
    start: async () => {
      throw new Error("disk start failed");
    },
  });
  const startAttemptsBeforeRequest = [];
  const { runner } = createFixtureRunner({
    archiveFixture,
    request: async () => {
      startAttemptsBeforeRequest.push(archiveFixture.calls.start.length);
      return startAttemptsBeforeRequest.length === 1
        ? response(activeOrder({
            orderNum: 2,
            flowerId: 23_002,
            bag: { 23_002: 15 },
          }))
        : response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(startAttemptsBeforeRequest.length, 2);
  assert.ok(startAttemptsBeforeRequest[1] >= 2);
  assert.deepEqual(result.archiveErrors, [{
    method: "start",
    kind: "error",
    message: "disk start failed",
  }]);
  assert.equal(result.finalReason, "server-ended");
});

test("archive append failure isolates the archive, records the path, and lets business continue", async () => {
  const archiveFixture = createRecordingArchive({
    append: async () => {
      throw new Error("disk append failed");
    },
  });
  let requestCount = 0;
  const { runner } = createFixtureRunner({
    archiveFixture,
    request: async () => {
      requestCount += 1;
      return requestCount === 1
        ? response(activeOrder({
            orderNum: 2,
            flowerId: 23_002,
            bag: { 23_002: 15 },
          }))
        : response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestCount, 2);
  assert.deepEqual(result.archiveErrors, [{
    method: "append",
    kind: "error",
    message: "disk append failed",
  }]);
});

test("archive append timeout uses the injected bound before isolating and continuing business", async () => {
  const archiveFixture = createRecordingArchive({
    append: async () => await new Promise(() => {}),
  });
  const requestArchiveTimes = [];
  const fixture = createFixtureRunner({
    archiveFixture,
    archiveCallTimeoutMs: 25,
    request: async () => {
      requestArchiveTimes.push(fixture.archiveClock.monotonicMs);
      return requestArchiveTimes.length === 1
        ? response(activeOrder({
            orderNum: 2,
            flowerId: 23_002,
            bag: { 23_002: 15 },
          }))
        : response(syncWithTeam({ status: 0 }));
    },
  });

  const result = await fixture.runner.handle(activeOrder(), {
    trigger: "startup",
    config: fixtureRunnerConfig(),
  });

  assert.equal(requestArchiveTimes.length, 2);
  assert.ok(requestArchiveTimes[1] >= 25);
  assert.deepEqual(result.archiveErrors, [{
    method: "append",
    kind: "timeout",
    message: "archive append timed out after 25ms",
  }]);
});
