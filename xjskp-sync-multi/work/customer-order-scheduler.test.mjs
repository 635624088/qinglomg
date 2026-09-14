import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_ORDER_GENERATION_DELAY_MS,
  CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  createCustomerOrderScheduler,
} from "./customer-order-scheduler.mjs";

const READY = {
  dailyCountKnown: true,
  tdyCompletedCount: 10,
  dailyLimit: 350,
  pendingOrderCount: 0,
  customerMax: 3,
  availableNpcIds: [4, 8],
  availableNpcCount: 2,
  availableNpcSourceKnown: true,
};

test("customer scheduler waits until nextGenTime plus 1001ms and deduplicates repeated wakeups", () => {
  const scheduler = createCustomerOrderScheduler({ retryIntervalMs: 30_000 });
  scheduler.observeSync({ nextGenTimeMs: 10_000, nowMs: 0 });

  assert.equal(CUSTOMER_ORDER_GENERATION_DELAY_MS, 1_001);
  assert.equal(
    scheduler.evaluate({ nowMs: 11_000, timeTrusted: true, preconditions: READY }).reason,
    "next-generation-cooldown",
  );
  const due = scheduler.evaluate({ nowMs: 11_001, timeTrusted: true, preconditions: READY });
  assert.equal(due.due, true);
  assert.equal(scheduler.beginGeneration({ nowMs: 11_001, decision: due }), true);
  assert.equal(scheduler.beginGeneration({ nowMs: 11_001, decision: due }), false);
  assert.equal(scheduler.snapshot().lastSkipReason, "generation-in-flight");
});

test("customer scheduler consumes actionTime even when the clock is a local fallback", () => {
  const scheduler = createCustomerOrderScheduler({ retryIntervalMs: 30_000 });
  scheduler.observeSync({ nextGenTimeMs: 10_000, nowMs: 0 });

  const cooling = scheduler.evaluate({
    actionTime: { nowMs: 10_000, clockSource: "local-fallback" },
    timeTrusted: false,
    preconditions: READY,
  });
  assert.equal(cooling.due, false);
  assert.equal(cooling.reason, "next-generation-cooldown");
  assert.equal(
    scheduler.dueInMs({
      actionTime: { nowMs: 10_000, clockSource: "local-fallback" },
      timeTrusted: false,
      preconditions: READY,
    }),
    CUSTOMER_ORDER_GENERATION_DELAY_MS,
  );

  const due = scheduler.evaluate({
    actionTime: { nowMs: 11_001, clockSource: "local-fallback" },
    timeTrusted: false,
    preconditions: READY,
  });
  assert.equal(due.due, true);
  assert.equal(due.clockSource, "local-fallback");
  assert.equal(scheduler.beginGeneration({
    actionTime: { nowMs: 11_001, clockSource: "local-fallback" },
    decision: due,
    timeTrusted: false,
  }), true);
  assert.equal(scheduler.beginGeneration({
    actionTime: { nowMs: 11_001, clockSource: "local-fallback" },
    decision: due,
    timeTrusted: false,
  }), false);

  const coldStart = createCustomerOrderScheduler();
  const coldStartDecision = coldStart.evaluate({
    actionTime: { nowMs: 0, clockSource: "local-fallback" },
    timeTrusted: false,
    preconditions: READY,
  });
  assert.equal(coldStartDecision.due, true);
  assert.equal(coldStartDecision.reason, "initial-generation-due");
  assert.equal(
    coldStart.dueInMs({
      actionTime: { nowMs: 0, clockSource: "local-fallback" },
      timeTrusted: false,
      preconditions: READY,
    }),
    0,
  );
});

test("customer scheduler fails closed for an invalid clock or invalid nextGenTime", () => {
  const invalidClock = createCustomerOrderScheduler();
  invalidClock.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const clockDecision = invalidClock.evaluate({
    actionTime: { nowMs: Number.NaN, clockSource: "local-fallback" },
    preconditions: READY,
  });
  assert.equal(clockDecision.due, false);
  assert.equal(clockDecision.reason, "invalid-clock");
  assert.equal(invalidClock.dueInMs({
    actionTime: { nowMs: Number.NaN, clockSource: "local-fallback" },
    preconditions: READY,
  }), Infinity);
  assert.equal(invalidClock.beginGeneration({
    actionTime: { nowMs: Number.NaN, clockSource: "local-fallback" },
  }), false);

  const invalidNext = createCustomerOrderScheduler();
  invalidNext.observeSync({ nextGenTimeMs: Number.NaN, nowMs: 0 });
  const nextDecision = invalidNext.evaluate({
    actionTime: { nowMs: 2_001, clockSource: "local-fallback" },
    preconditions: READY,
  });
  assert.equal(nextDecision.due, false);
  assert.equal(nextDecision.reason, "next-generation-time-invalid");
});

test("customer scheduler failure uses the 30-second retry cadence and success adopts the server nextGenTime", () => {
  const scheduler = createCustomerOrderScheduler({ retryIntervalMs: 30_000 });
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const due = scheduler.evaluate({ nowMs: 2_001, timeTrusted: true, preconditions: READY });
  assert.equal(scheduler.beginGeneration({ nowMs: 2_001, decision: due }), true);
  scheduler.failGeneration({ nowMs: 2_002, reason: "transport-failure", category: "transport" });
  assert.equal(
    scheduler.evaluate({ nowMs: 32_002, timeTrusted: true, preconditions: READY }).due,
    true,
  );
  assert.equal(scheduler.beginGeneration({ nowMs: 32_002 }), true);
  scheduler.completeGeneration({
    nowMs: 32_100,
    nextGenTimeMs: 300_000,
    generatedOrderCount: 2,
  });
  const snapshot = scheduler.snapshot();
  assert.equal(snapshot.generationCount, 1);
  assert.equal(snapshot.generatedOrderCount, 2);
  assert.equal(snapshot.nextGenTimeMs, 300_000);
  assert.equal(snapshot.lastOutcome, "success");
});

test("customer scheduler preserves official customer generation prerequisites", () => {
  const scheduler = createCustomerOrderScheduler();
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const cases = [
    [{ ...READY, pendingOrderCount: 3, customerMax: 3 }, "customer-max-reached"],
    [{ ...READY, tdyCompletedCount: 347, pendingOrderCount: 3, customerMax: 99, dailyLimit: 350 }, "daily-generation-limit-reached"],
    [{ ...READY, availableNpcIds: [], availableNpcCount: 0 }, "no-available-npcs"],
  ];
  for (const [preconditions, reason] of cases) {
    const decision = scheduler.evaluate({ nowMs: 2_001, timeTrusted: true, preconditions });
    assert.equal(decision.due, false);
    assert.equal(decision.reason, reason);
  }
});

test("customer scheduler allows an empty real-visitor exclusion list when candidates are available", () => {
  const scheduler = createCustomerOrderScheduler();
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const decision = scheduler.evaluate({
    nowMs: 2_001,
    timeTrusted: true,
    preconditions: {
      ...READY,
      guestNpcIds: [],
      availableNpcIds: [4, 8],
      availableNpcCount: 2,
    },
  });
  assert.equal(decision.due, true);
  assert.equal(decision.reason, "next-generation-due");
});

test("customer scheduler fails closed when the official daily generation state is unknown", () => {
  for (const preconditions of [
    { ...READY, dailyCountKnown: false },
    { ...READY, tdyCompletedCount: null },
    { ...READY, dailyLimit: null },
    { ...READY, tdyCompletedCount: -1 },
    { ...READY, dailyLimit: 350.5 },
  ]) {
    const scheduler = createCustomerOrderScheduler();
    scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
    const decision = scheduler.evaluate({
      nowMs: 2_001,
      timeTrusted: true,
      preconditions,
    });
    assert.equal(decision.due, false);
    assert.equal(decision.reason, "daily-generation-state-unknown");
    assert.equal(
      scheduler.dueInMs({ nowMs: 2_001, timeTrusted: true, preconditions }),
      CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
    );
  }
});

test("customer scheduler fails closed when the official customer max is unknown", () => {
  const scheduler = createCustomerOrderScheduler();
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const decision = scheduler.evaluate({
    nowMs: 2_001,
    timeTrusted: true,
    preconditions: { ...READY, customerMax: null },
  });
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "customer-max-state-unknown");
  assert.equal(
    scheduler.dueInMs({
      nowMs: 2_001,
      timeTrusted: true,
      preconditions: { ...READY, customerMax: null },
    }),
    CUSTOMER_ORDER_HEALTH_CHECK_INTERVAL_MS,
  );

  const invalid = createCustomerOrderScheduler();
  invalid.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const invalidDecision = invalid.evaluate({
    nowMs: 2_001,
    timeTrusted: true,
    preconditions: { ...READY, customerMax: 3.5 },
  });
  assert.equal(invalidDecision.due, false);
  assert.equal(invalidDecision.reason, "customer-max-state-unknown");
});

test("customer scheduler fails closed when the available NPC source is unknown", () => {
  const scheduler = createCustomerOrderScheduler();
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const decision = scheduler.evaluate({
    nowMs: 2_001,
    timeTrusted: true,
    preconditions: {
      ...READY,
      availableNpcIds: null,
      availableNpcCount: null,
      availableNpcSourceKnown: false,
    },
  });
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "available-npc-state-unknown");
});

test("customer scheduler treats omitted prerequisites as unknown instead of requesting", () => {
  const scheduler = createCustomerOrderScheduler();
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const decision = scheduler.evaluate({ nowMs: 2_001, timeTrusted: true });
  assert.equal(decision.due, false);
  assert.equal(decision.reason, "daily-generation-state-unknown");
});

test("customer scheduler records generation-to-action and make-to-finish latency", () => {
  const scheduler = createCustomerOrderScheduler();
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const due = scheduler.evaluate({ nowMs: 2_001, timeTrusted: true, preconditions: READY });
  scheduler.beginGeneration({ nowMs: 2_001, decision: due });
  scheduler.completeGeneration({ nowMs: 2_010, nextGenTimeMs: 100_000, generatedOrderCount: 1 });
  const firstAction = scheduler.recordAction({ nowMs: 2_050, type: "makeFlowerArt", npcId: 8 });
  const finish = scheduler.recordAction({ nowMs: 2_200, type: "finishCustomerOrder", npcId: 8 });

  assert.equal(firstAction.generationToFirstActionMs, 40);
  assert.equal(finish.makeToFinishDelayMs, 150);
  assert.equal(firstAction.latencyMetricBasis, "request-start");
  assert.equal(scheduler.snapshot().latencyMetricBasis, "request-start");
  assert.equal(scheduler.snapshot().lastActionType, "finishCustomerOrder");
});

test("customer scheduler measures request-start latency and keeps a no-new-order success on health retry", () => {
  const scheduler = createCustomerOrderScheduler({ retryIntervalMs: 30_000 });
  scheduler.observeSync({ nextGenTimeMs: 1_000, nowMs: 0 });
  const due = scheduler.evaluate({ nowMs: 2_001, timeTrusted: true, preconditions: READY });
  assert.equal(scheduler.beginGeneration({
    nowMs: 2_001,
    requestStartedAtMs: 2_001,
    decision: due,
  }), true);
  scheduler.completeGeneration({
    nowMs: 2_100,
    requestStartedAtMs: 2_001,
    responseAtMs: 2_100,
    nextGenTimeMs: 1_000,
    generatedOrderCount: 0,
  });

  const afterNoNew = scheduler.snapshot();
  assert.equal(afterNoNew.lastGenerationRequestStartAtMs, 2_001);
  assert.equal(afterNoNew.lastGenerationResponseAtMs, 2_100);
  assert.equal(afterNoNew.retryAtMs, 32_001);
  assert.equal(
    scheduler.dueInMs({ nowMs: 2_001, timeTrusted: true, preconditions: READY }),
    30_000,
  );

  const make = scheduler.recordAction({
    nowMs: 2_500,
    requestStartedAtMs: 2_500,
    requestSequence: 1,
    type: "makeFlowerArt",
    npcId: 8,
  });
  const finish = scheduler.recordAction({
    nowMs: 2_900,
    requestStartedAtMs: 2_800,
    requestSequence: 2,
    type: "finishCustomerOrder",
    npcId: 8,
  });
  assert.equal(make.generationToFirstActionMs, 499);
  assert.equal(finish.makeToFinishDelayMs, 300);
  assert.equal(finish.requestStartAtMs, 2_800);
  assert.equal(finish.requestSequence, 2);
});
