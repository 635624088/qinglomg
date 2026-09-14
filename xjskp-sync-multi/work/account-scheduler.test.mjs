import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createAccountScheduler } from "./account-scheduler.mjs";

test("account scheduler runs modules only when nextRunAt is due", async () => {
  let nowMs = Date.parse("2026-08-11T10:00:00.000Z");
  const scheduler = createAccountScheduler({ nowFn: () => nowMs });
  let runs = 0;

  const first = await scheduler.runDue("flowerRack", {
    intervalMs: 120_000,
    task: async () => ++runs,
  });
  const early = await scheduler.runDue("flowerRack", {
    intervalMs: 120_000,
    task: async () => ++runs,
  });
  nowMs += 120_000;
  const due = await scheduler.runDue("flowerRack", {
    intervalMs: 120_000,
    task: async () => ++runs,
  });

  assert.deepEqual(
    { first: first.ran, early: early.ran, due: due.ran, runs },
    { first: true, early: false, due: true, runs: 2 },
  );
  const state = scheduler.snapshot().modules.flowerRack;
  assert.equal(state.runCount, 2);
  assert.equal(state.lastOutcome, "success");
  assert.equal(state.nextRunAt, "2026-08-11T10:04:00.000Z");
  assert.equal(scheduler.hasModule("flowerRack"), true);
  assert.equal(scheduler.hasModule("materialShop"), false);
});

test("account schedulers keep nextRunAt isolated per account", async () => {
  let nowA = 1000;
  let nowB = 1000;
  const accountA = createAccountScheduler({ accountId: "A", nowFn: () => nowA });
  const accountB = createAccountScheduler({ accountId: "B", nowFn: () => nowB });

  await accountA.runDue("pearl", { intervalMs: 3000, task: async () => "A" });

  assert.equal(accountA.isDue("pearl"), false);
  assert.equal(accountB.isDue("pearl", { intervalMs: 3000 }), true);
  assert.equal(accountA.snapshot().accountId, "A");
  assert.equal(accountB.snapshot().modules.pearl.nextRunAtMs, 1000);

  nowB = 2000;
  await accountB.runDue("pearl", { intervalMs: 3000, task: async () => "B" });
  assert.equal(accountA.snapshot().modules.pearl.nextRunAtMs, 4000);
  assert.equal(accountB.snapshot().modules.pearl.nextRunAtMs, 5000);
});

test("authoritative snapshot refresh is single-flight and reused until due", async () => {
  let nowMs = 10_000;
  let refreshCount = 0;
  let releaseRefresh;
  const gate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const scheduler = createAccountScheduler({ nowFn: () => nowMs });
  const refresher = async (current) => {
    refreshCount += 1;
    await gate;
    return { ...current, revision: refreshCount };
  };

  const firstPromise = scheduler.getAuthoritativeSnapshot({
    currentValue: { revision: 0 },
    intervalMs: 30_000,
    refresher,
  });
  const secondPromise = scheduler.getAuthoritativeSnapshot({
    currentValue: { revision: 0 },
    intervalMs: 30_000,
    refresher,
  });
  releaseRefresh();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);
  const cached = await scheduler.getAuthoritativeSnapshot({
    currentValue: first,
    intervalMs: 30_000,
    refresher,
  });

  assert.equal(refreshCount, 1);
  assert.strictEqual(first, second);
  assert.strictEqual(cached, first);
  assert.equal(scheduler.snapshot().authority.refreshCount, 1);

  nowMs += 30_000;
  const refreshed = await scheduler.getAuthoritativeSnapshot({
    currentValue: cached,
    intervalMs: 30_000,
    refresher: async (current) => {
      refreshCount += 1;
      return { ...current, revision: refreshCount };
    },
  });
  assert.equal(refreshed.revision, 2);
});

test("failed modules advance nextRunAt so a clock tick cannot busy-loop", async () => {
  let nowMs = 5000;
  const scheduler = createAccountScheduler({ nowFn: () => nowMs });
  let attempts = 0;

  await assert.rejects(
    scheduler.runDue("authoritativeSnapshot", {
      intervalMs: 30_000,
      retryIntervalMs: 5000,
      task: async () => {
        attempts += 1;
        throw new Error("temporary failure");
      },
    }),
    /temporary failure/,
  );
  const early = await scheduler.runDue("authoritativeSnapshot", {
    intervalMs: 30_000,
    retryIntervalMs: 5000,
    task: async () => ++attempts,
  });

  assert.equal(early.ran, false);
  assert.equal(attempts, 1);
  assert.equal(scheduler.snapshot().modules.authoritativeSnapshot.nextRunAtMs, 10_000);
  assert.equal(scheduler.snapshot().modules.authoritativeSnapshot.failureCount, 1);

  nowMs = 4000;
  assert.equal(scheduler.dueInMs("authoritativeSnapshot"), 6000);
});

test("automation loop wires one account scheduler through cycles and idle waits", () => {
  const source = fs.readFileSync(new URL("./inspect-garden-dryrun.mjs", import.meta.url), "utf8");

  assert.match(source, /const accountScheduler = options\.accountScheduler \|\| createAccountScheduler\(/);
  assert.match(source, /runGardenCycle\([^\n]+\{ teamOrderRuntime, accountScheduler \}\)/);
  assert.match(source, /waitWithOnlineHeartTick\([\s\S]+?accountScheduler,[\s\S]+?\}\);/);
  for (const moduleName of [
    "flowerUpgrade",
    "fmlLand",
    "flowerRack",
    "pearl",
    "materialShop",
    "cyclicStory",
    "cyclicNote",
  ]) {
    assert.match(source, new RegExp(`runScheduledCycleStep\\(\\s*[\"']${moduleName}[\"']`));
  }
});
