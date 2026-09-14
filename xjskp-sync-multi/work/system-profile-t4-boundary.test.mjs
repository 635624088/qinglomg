import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { buildPackagePlan } from "./system/package-green.mjs";

const rootDir = path.resolve(import.meta.dirname, "..");

test("T5 atomically activates coordinated server and transaction client composition", async () => {
  const [server, app, startCoordination] = await Promise.all([
    fs.readFile(path.join(rootDir, "work", "system", "server.mjs"), "utf8"),
    fs.readFile(path.join(rootDir, "work", "system", "public", "app.js"), "utf8"),
    fs.readFile(path.join(rootDir, "work", "system", "profile-start-coordination.mjs"), "utf8"),
  ]);
  assert.equal(server.includes("profile-start-coordination"), true);
  assert.equal(server.includes("profile-canonical-migration"), true);
  assert.equal(server.includes("recoveryCoordinator"), true);
  assert.equal(startCoordination.includes("beginAutomationAlreadyCoordinated"), true);
  assert.equal(app.includes("profile-settings-client"), true);
  assert.equal(app.includes("beginProfileSettingsUpdate"), false);
  assert.equal(app.includes("rollbackProfileSettingsUpdate"), false);
});

test("T5 coordinated modules and transaction client are packaged while tests and red fixtures remain excluded", () => {
  const plan = buildPackagePlan({
    rootDir,
    outputDir: path.join(rootDir, "release", "xjskp-sync-multi-next"),
    nodeExe: "C:\\node\\node.exe",
  });
  const destinations = new Set(plan.entries.map((entry) => entry.to.replace(/\\/g, "/")));
  assert.equal(destinations.has("work/system/profile-start-coordination.mjs"), true);
  assert.equal(destinations.has("work/system/profile-canonical-migration.mjs"), true);
  assert.equal(destinations.has("work/system/public/profile-settings-client.js"), true);
  assert.equal([...destinations].some((item) => item.endsWith(".test.mjs")), false);
  assert.equal([...destinations].some((item) => item.endsWith(".red.mjs")), false);
});
