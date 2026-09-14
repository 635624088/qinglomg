import assert from "node:assert/strict";
import test from "node:test";

import { createProfileOperationCoordinator } from "./system/profile-operation-coordinator.mjs";

test("profile operation coordinator serializes one profile, keeps other profiles parallel, and recovers after failure", async () => {
  const coordinator = createProfileOperationCoordinator();
  let releaseMain;
  const mainGate = new Promise((resolve) => {
    releaseMain = resolve;
  });
  let mainStarted;
  const mainStartedPromise = new Promise((resolve) => {
    mainStarted = resolve;
  });
  const events = [];

  const first = coordinator.run("main", async () => {
    events.push("main-first");
    mainStarted();
    await mainGate;
    throw new Error("expected failure");
  });
  await mainStartedPromise;
  const second = coordinator.run("main", async () => {
    events.push("main-second");
    return "recovered";
  });
  const other = coordinator.run("other", async () => {
    events.push("other");
    return "parallel";
  });

  assert.equal(await other, "parallel");
  assert.deepEqual(events, ["main-first", "other"]);
  releaseMain();
  await assert.rejects(first, /expected failure/);
  assert.equal(await second, "recovered");
  assert.deepEqual(events, ["main-first", "other", "main-second"]);
});
