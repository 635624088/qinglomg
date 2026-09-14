import assert from "node:assert/strict";
import test from "node:test";

import {
  CYCLIC_NOTE_NATURAL_TASK_ROUTES,
  getCyclicNoteNaturalRoutePolicy,
  planCyclicNoteNaturalCompletion,
} from "./cyclic-note-natural-completion.mjs";

function slot(slotIndex, overrides = {}) {
  return {
    slotIndex,
    taskId: 1000 + slotIndex,
    type: 1009,
    current: 0,
    target: 5,
    rewardScoreCount: slotIndex,
    received: false,
    canReceive: false,
    ...overrides,
  };
}

function status(taskSlots, overrides = {}) {
  return {
    exists: true,
    active: true,
    phase: 2,
    batchId: 329,
    executionSafe: true,
    snapshotError: null,
    taskSlots,
    ...overrides,
  };
}

test("completed authoritative slots are planned for normal receipt before any task route", () => {
  const plan = planCyclicNoteNaturalCompletion(status([
    slot(1, { canReceive: true, current: 5, rewardScoreCount: 1 }),
    slot(2, { canReceive: true, current: 5, rewardScoreCount: 9 }),
    slot(3, { rewardScoreCount: 99 }),
  ]));
  assert.equal(plan.kind, "receive");
  assert.deepEqual(plan.receives.map((action) => action.taskId), [1001, 1002]);
});

test("without completed slots the highest supported reward is selected", () => {
  const plan = planCyclicNoteNaturalCompletion(status([
    slot(1, { type: 1009, rewardScoreCount: 3 }),
    slot(2, { type: 3014, rewardScoreCount: 8 }),
    slot(3, { type: 1010, rewardScoreCount: 8 }),
  ]), { onlyHighestRewardTask: true });
  assert.equal(plan.kind, "action");
  assert.equal(plan.target.slotIndex, 2);
  assert.equal(plan.route, "water");
});

test("an unsupported higher reward does not skip the next highest supported slot", () => {
  const plan = planCyclicNoteNaturalCompletion(status([
    slot(1, { type: 9999, rewardScoreCount: 9 }),
    slot(2, { type: 3014, rewardScoreCount: 8 }),
    slot(3, { type: 1009, rewardScoreCount: 1 }),
  ]));
  assert.equal(plan.kind, "action");
  assert.equal(plan.target.slotIndex, 2);
  assert.equal(plan.route, "water");
});

test("equal rewards use slot order", () => {
  const plan = planCyclicNoteNaturalCompletion(status([
    slot(1, { rewardScoreCount: 7 }),
    slot(2, { rewardScoreCount: 7 }),
    slot(3, { rewardScoreCount: 1 }),
  ]), { onlyHighestRewardTask: true });
  assert.equal(plan.kind, "action");
  assert.equal(plan.target.slotIndex, 1);
});

test("all-task strategy keeps every safe supported candidate in slot order", () => {
  const plan = planCyclicNoteNaturalCompletion(status([
    slot(1, { type: 1009, rewardScoreCount: 1 }),
    slot(2, { type: 9999, rewardScoreCount: 99 }),
    slot(3, { type: 3014, rewardScoreCount: 8 }),
  ]), { onlyHighestRewardTask: false });
  assert.equal(plan.kind, "action");
  assert.equal(plan.reason, "all-supported-unfinished-tasks");
  assert.deepEqual(plan.targets.map((target) => target.slotIndex), [1, 3]);
});

test("unsafe or route-blocked slots do not starve another supported task", () => {
  const plan = planCyclicNoteNaturalCompletion(status([
    slot(1, { type: 1009, rewardScoreCount: 9, routeBlockedReason: "blocked" }),
    slot(2, { type: 3014, rewardScoreCount: 8 }),
    slot(3, { type: 1009, rewardScoreCount: 1, current: null }),
  ]), { onlyHighestRewardTask: true });
  assert.equal(plan.kind, "action");
  assert.equal(plan.target.slotIndex, 2);
  assert.deepEqual(plan.targets.map((target) => target.slotIndex), [2]);
});

test("supported task types keep their existing business routes", () => {
  for (const [type, route] of Object.entries(CYCLIC_NOTE_NATURAL_TASK_ROUTES)) {
    const plan = planCyclicNoteNaturalCompletion(status([
      slot(1, { type: Number(type), rewardScoreCount: 9 }),
      slot(2, { rewardScoreCount: 1 }),
      slot(3, { rewardScoreCount: 1 }),
    ]));
    assert.equal(plan.kind, "action", type);
    assert.equal(plan.route, route, type);
  }
});

test("natural routes bypass only the two user-approved policies and preserve the experience guard", () => {
  const expectedByRoute = {
    "resident-order": ["ordinary-switch"],
    "pearl-hire": ["hire-item-reserve"],
    plant: [],
    harvest: [],
    water: [],
    "flower-rack-sell": [],
    "customer-order": [],
  };

  for (const route of Object.values(CYCLIC_NOTE_NATURAL_TASK_ROUTES)) {
    const policy = getCyclicNoteNaturalRoutePolicy(route);
    assert.deepEqual(policy.bypassedBusinessPolicies, expectedByRoute[route], route);
    assert.equal(policy.preserveExperienceGuard, true, route);
    assert.equal(policy.preserveAuthoritativeState, true, route);
    assert.equal(policy.preserveResourceAvailability, true, route);
  }
});

test("unsafe snapshots and all-unsupported slots produce no action", () => {
  for (const input of [
    status([slot(1), slot(2), slot(3)], { executionSafe: false, snapshotError: "missing-authoritative-task-record" }),
    status([
      slot(1, { type: 9999 }),
      slot(2, { type: 9999 }),
      slot(3, { type: 9999, rewardScoreCount: 9 }),
    ]),
  ]) {
    const plan = planCyclicNoteNaturalCompletion(input);
    assert.equal(plan.kind, "none");
    assert.deepEqual(plan.receives, []);
    assert.equal(plan.route, null);
  }
});
