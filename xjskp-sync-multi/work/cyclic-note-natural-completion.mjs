import { CYCLIC_NOTE_IFACES } from "./cyclic-note-state.mjs";

export const CYCLIC_NOTE_NATURAL_TASK_ROUTES = Object.freeze({
  1009: "resident-order",
  1010: "pearl-hire",
  3001: "plant",
  3002: "harvest",
  3014: "water",
  3015: "flower-rack-sell",
  3016: "customer-order",
});

const CYCLIC_NOTE_NATURAL_ROUTE_POLICIES = Object.freeze({
  "resident-order": Object.freeze({
    bypassedBusinessPolicies: Object.freeze(["ordinary-switch"]),
  }),
  "pearl-hire": Object.freeze({
    bypassedBusinessPolicies: Object.freeze(["hire-item-reserve"]),
    hireItemReserveCount: 0,
  }),
  plant: Object.freeze({
    bypassedBusinessPolicies: Object.freeze([]),
  }),
  harvest: Object.freeze({
    bypassedBusinessPolicies: Object.freeze([]),
  }),
  water: Object.freeze({
    bypassedBusinessPolicies: Object.freeze([]),
  }),
  "flower-rack-sell": Object.freeze({
    bypassedBusinessPolicies: Object.freeze([]),
  }),
  "customer-order": Object.freeze({
    bypassedBusinessPolicies: Object.freeze([]),
  }),
});

export function getCyclicNoteNaturalRoutePolicy(route) {
  const policy = CYCLIC_NOTE_NATURAL_ROUTE_POLICIES[route];
  if (!policy) return null;
  return {
    ...policy,
    bypassedBusinessPolicies: [...policy.bypassedBusinessPolicies],
    preserveExperienceGuard: true,
    preserveAuthoritativeState: true,
    preserveResourceAvailability: true,
  };
}

function isSafePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function noAction(reason, status = null, target = null) {
  return {
    kind: "none",
    reason,
    status,
    target,
    targets: [],
    route: null,
    receives: [],
  };
}

function isCompletedUnclaimedSlot(slot) {
  return slot?.canReceive === true && slot?.received !== true;
}

function isSupportedUnfinishedSlot(slot) {
  return isSafePositiveInteger(slot?.taskId)
    && slot?.received !== true
    && slot?.canReceive !== true
    && isSafePositiveInteger(slot?.type)
    && isSafeNonNegativeInteger(slot?.rewardScoreCount)
    && isSafeNonNegativeInteger(slot?.current)
    && isSafePositiveInteger(slot?.target);
}

function routeForTaskType(taskType) {
  return CYCLIC_NOTE_NATURAL_TASK_ROUTES[taskType] || null;
}

/**
 * Plans only from one authoritative enter snapshot.
 * Completed slots are always returned first. Unfinished supported slots are
 * ordered by the selected account strategy. A blocked candidate must not
 * prevent the executor from trying the next candidate without a new snapshot.
 */
export function planCyclicNoteNaturalCompletion(status, options = {}) {
  if (status?.executionSafe !== true || status?.snapshotError) {
    return noAction(status?.snapshotError || "unsafe-authoritative-snapshot", status || null);
  }
  if (!status?.exists || status.active !== true || status.phase !== 2) {
    return noAction("activity-not-active", status || null);
  }
  if (!isSafePositiveInteger(status.batchId)) {
    return noAction("invalid-batch-id", status || null);
  }
  if (!Array.isArray(status.taskSlots) || status.taskSlots.length !== 3) {
    return noAction("incomplete-three-slot-snapshot", status || null);
  }

  const receives = status.taskSlots
    .filter(isCompletedUnclaimedSlot)
    .map((slot) => ({
      kind: "cyclicNote",
      iface: CYCLIC_NOTE_IFACES.recvTaskRwd,
      args: { batchId: status.batchId, taskId: slot.taskId },
      batchId: status.batchId,
      taskId: slot.taskId,
      slotIndex: slot.slotIndex,
      reason: "cyclic-note-task-ready",
    }));
  if (receives.length) {
    return {
      kind: "receive",
      reason: "completed-tasks-first",
      status,
      target: null,
      route: null,
      receives,
    };
  }

  const unfinished = status.taskSlots.filter((slot) => slot?.received !== true && slot?.canReceive !== true);
  if (!unfinished.length) return noAction("no-unfinished-task", status || null);
  const routedUnfinished = unfinished.filter((slot) => (
    routeForTaskType(slot?.type)
    && isSupportedUnfinishedSlot(slot)
    && !slot.routeBlockedReason
  ));
  if (!routedUnfinished.length) return noAction("unsupported-task-type", status || null);
  const onlyHighestRewardTask = options?.onlyHighestRewardTask === true;
  const targets = [...routedUnfinished]
    .sort((left, right) => (
      onlyHighestRewardTask
        ? right.rewardScoreCount - left.rewardScoreCount || left.slotIndex - right.slotIndex
        : left.slotIndex - right.slotIndex
    ))
    .map((slot) => ({ ...slot, route: routeForTaskType(slot.type) }));
  const target = targets[0];
  const route = routeForTaskType(target.type);
  if (!route) return noAction("unsupported-task-type", status || null, target);

  return {
    kind: "action",
    reason: onlyHighestRewardTask ? "highest-reward-unfinished-task" : "all-supported-unfinished-tasks",
    status,
    target,
    targets,
    route,
    receives: [],
  };
}
