import test from "node:test";
import assert from "node:assert/strict";

import { createGameDataOperationCoordinator } from "./system/game-data-operation-coordinator.mjs";

test("data sync, version checks, and runtime starts use one fail-fast barrier", async () => {
  const coordinator = createGameDataOperationCoordinator();
  let releaseSync;
  const syncStarted = new Promise((resolve) => { releaseSync = resolve; });
  let entered = false;
  const sync = coordinator.runGameDataSync(async () => {
    entered = true;
    await syncStarted;
    return "synced";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entered, true);

  await assert.rejects(
    coordinator.runVersionCheck(async () => "checked"),
    (error) => error.statusCode === 409 && error.code === "GAME_DATA_SYNC_IN_PROGRESS",
  );
  await assert.rejects(
    coordinator.reserveRuntimeTransition("main", "start"),
    (error) => error.statusCode === 409 && error.code === "GAME_DATA_SYNC_IN_PROGRESS",
  );

  releaseSync();
  assert.equal(await sync, "synced");
  const reservation = await coordinator.reserveRuntimeTransition("main", "start");
  reservation.release();
  assert.equal(await coordinator.runVersionCheck(async () => "checked"), "checked");
});

test("runtime transition wins atomically over sync and releases idempotently", async () => {
  const coordinator = createGameDataOperationCoordinator();
  const reservation = await coordinator.reserveRuntimeTransition("main", "recovery");

  await assert.rejects(
    coordinator.runGameDataSync(async () => assert.fail("blocked sync must not run")),
    (error) => error.statusCode === 409 && error.code === "GAME_DATA_SYNC_RUNTIME_ACTIVE",
  );
  reservation.release();
  reservation.release();
  assert.equal(await coordinator.runGameDataSync(async () => "ok"), "ok");
});

test("two version checks keep the legacy conflict code and failed operations release the barrier", async () => {
  const coordinator = createGameDataOperationCoordinator();
  let releaseCheck;
  const waiting = new Promise((resolve) => { releaseCheck = resolve; });
  const first = coordinator.runVersionCheck(() => waiting);
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    coordinator.runVersionCheck(async () => null),
    (error) => error.statusCode === 409 && error.code === "VERSION_CHECK_IN_PROGRESS",
  );
  releaseCheck("done");
  assert.equal(await first, "done");

  await assert.rejects(
    coordinator.runGameDataSync(async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(await coordinator.runVersionCheck(async () => "after"), "after");
});
