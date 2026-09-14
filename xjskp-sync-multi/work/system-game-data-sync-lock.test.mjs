import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireGameDataSyncLock,
  assertGameDataSyncStartAllowed,
  gameDataSyncLockPath,
  recoverStaleGameDataSyncLock,
} from "./system/game-data-sync-lock.mjs";

test("persistent sync lock blocks standalone starts and releases only its own token", async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-sync-lock-"));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const reservation = await acquireGameDataSyncLock({ runtimeDir, ownerId: "owner-a" });
  assert.throws(
    () => assertGameDataSyncStartAllowed({ runtimeDir }),
    (error) => error.code === "GAME_DATA_SYNC_IN_PROGRESS",
  );
  await assert.rejects(
    acquireGameDataSyncLock({ runtimeDir, ownerId: "owner-b" }),
    (error) => error.code === "GAME_DATA_SYNC_IN_PROGRESS",
  );
  await reservation.release();
  assert.equal(assertGameDataSyncStartAllowed({ runtimeDir }), true);
});

test("startup recovery removes only a lock whose owner process is no longer alive", async (t) => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-sync-lock-recover-"));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  await fs.mkdir(path.dirname(gameDataSyncLockPath(runtimeDir)), { recursive: true });
  await fs.writeFile(gameDataSyncLockPath(runtimeDir), JSON.stringify({ schemaVersion: 1, ownerPid: 999 }), "utf8");
  assert.equal(await recoverStaleGameDataSyncLock({ runtimeDir, isProcessAlive: () => true }), false);
  assert.throws(() => assertGameDataSyncStartAllowed({ runtimeDir }), /同步期间/);
  assert.equal(await recoverStaleGameDataSyncLock({ runtimeDir, isProcessAlive: () => false }), true);
  assert.equal(assertGameDataSyncStartAllowed({ runtimeDir }), true);
});
