import assert from "node:assert/strict";
import test from "node:test";

const viewModule = await import("./system/public/team-order-view.js").catch(() => ({}));
const {
  TEAM_ORDER_VISIBLE_DAY_COUNT,
  computeTeamOrderGuardExp,
  getRecentCompletedTeamOrderGroups,
} = viewModule;

function localTimestamp(year, monthIndex, day, hour, minute = 0, second = 0) {
  return new Date(year, monthIndex, day, hour, minute, second).toISOString();
}

test("team-order view keeps exactly today plus the previous six local calendar days", () => {
  assert.equal(TEAM_ORDER_VISIBLE_DAY_COUNT, 7);
  assert.equal(typeof getRecentCompletedTeamOrderGroups, "function");

  const now = new Date(2026, 6, 30, 12, 0, 0);
  const items = [
    { runId: "today-early", finishedAt: localTimestamp(2026, 6, 30, 8) },
    { runId: "today-late", finishedAt: localTimestamp(2026, 6, 30, 11) },
    { runId: "yesterday", finishedAt: localTimestamp(2026, 6, 29, 23) },
    { runId: "oldest-visible", finishedAt: localTimestamp(2026, 6, 24, 0) },
    { runId: "too-old", finishedAt: localTimestamp(2026, 6, 23, 23, 59, 59) },
    { runId: "future", finishedAt: localTimestamp(2026, 6, 30, 13) },
    { runId: "unfinished", finishedAt: null },
    { runId: "invalid", finishedAt: "not-a-date" },
    { runId: "damaged", finishedAt: localTimestamp(2026, 6, 30, 10), readError: true },
  ];

  const groups = getRecentCompletedTeamOrderGroups(items, { now });

  assert.deepEqual(groups.map((group) => group.dateLabel), [
    "2026/07/30",
    "2026/07/29",
    "2026/07/24",
  ]);
  assert.deepEqual(groups[0].items.map((item) => item.runId), [
    "today-early",
    "today-late",
  ]);
  assert.deepEqual(groups.flatMap((group) => group.items.map((item) => item.runId)), [
    "today-early",
    "today-late",
    "yesterday",
    "oldest-visible",
  ]);
});

test("team-order view keeps all completed records in the same day group", () => {
  const now = new Date(2026, 6, 30, 23, 0, 0);
  const items = Array.from({ length: 5 }, (_, index) => ({
    runId: `same-day-${index + 1}`,
    finishedAt: localTimestamp(2026, 6, 30, index + 1),
  }));

  const groups = getRecentCompletedTeamOrderGroups(items, { now });

  assert.equal(groups.length, 1);
  assert.equal(groups[0].items.length, 5);
  assert.deepEqual(groups[0].items.map((item) => item.runId), [
    "same-day-1",
    "same-day-2",
    "same-day-3",
    "same-day-4",
    "same-day-5",
  ]);
});

test("team-order view computes guard experience locally from history max and multiplier", () => {
  assert.equal(typeof computeTeamOrderGuardExp, "function");
  assert.equal(computeTeamOrderGuardExp(893860, 0.02), 17877.2);
  assert.equal(computeTeamOrderGuardExp(5000, 2), 10000);
  assert.equal(computeTeamOrderGuardExp(5000, 0), 0);
  assert.equal(computeTeamOrderGuardExp(null, 2), null);
  assert.equal(computeTeamOrderGuardExp("abc", 2), null);
  assert.equal(computeTeamOrderGuardExp(5000, null), 10000);
  assert.equal(computeTeamOrderGuardExp(5000, 99), 10000);
  assert.equal(computeTeamOrderGuardExp("893860", "0.02"), 17877.2);
});
