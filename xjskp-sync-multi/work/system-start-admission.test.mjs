import test from "node:test";
import assert from "node:assert/strict";

import { createStartAdmission } from "./system/start-admission.mjs";

test("start admission rejects a profile while the same profile is starting", async () => {
  const admission = createStartAdmission({ maxParallelTasks: 3 });
  const reservation = await admission.reserve("main", async () => []);

  await assert.rejects(
    () => admission.reserve("main", async () => []),
    (err) => err.code === "ACTIVE_AUTOMATION_RUNNING",
  );

  reservation.release();
});

test("start admission counts reservations toward the parallel limit", async () => {
  const admission = createStartAdmission({ maxParallelTasks: 1 });
  const reservation = await admission.reserve("main", async () => []);

  await assert.rejects(
    () => admission.reserve("alt", async () => []),
    (err) => err.code === "MAX_PARALLEL_TASKS_REACHED"
      && err.runningCount === 1
      && err.maxParallelTasks === 1,
  );

  reservation.release();
});

test("start admission release is idempotent and permits a later start", async () => {
  const admission = createStartAdmission({ maxParallelTasks: 1 });
  const reservation = await admission.reserve("main", async () => []);
  reservation.release();
  reservation.release();

  const next = await admission.reserve("alt", async () => []);
  next.release();
});

test("start admission permits any number of distinct profiles without a configured limit", async () => {
  const admission = createStartAdmission({ maxParallelTasks: null });
  const reservations = [];
  const running = [];
  const readRunning = async () => running;

  for (const profileId of ["a", "b", "c", "d"]) {
    reservations.push(await admission.reserve(profileId, readRunning));
    running.push(profileId);
  }

  for (const reservation of reservations) reservation.release();
});
