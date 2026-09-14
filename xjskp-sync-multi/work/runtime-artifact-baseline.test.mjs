import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { AUTOMATION_GAME_CONTRACT } from "./automation-game-contract.mjs";
import {
  createRuntimeArtifactBaseline,
  runOfflineRuntimeArtifactBaseline,
} from "./runtime-artifact-baseline.mjs";

async function productionMjsFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "game-pkg" || entry.name === "game-pkg-latest") continue;
      files.push(...await productionMjsFiles(filePath));
    } else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
      files.push(filePath);
    }
  }
  return files;
}

test("production game interface references exactly match the frozen automation contract", async () => {
  const names = new Set(AUTOMATION_GAME_CONTRACT.interfaces.map((entry) => entry.iface));
  const references = new Set();
  for (const filePath of await productionMjsFiles("work")) {
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(/\bgs\.[A-Za-z0-9_$]+\.[A-Za-z0-9_$]+\b/g)) {
      references.add(match[0]);
    }
  }
  assert.deepEqual([...references].sort(), [...names].sort());
});

test("production request cadence and system-log tee seams remain guarded", async () => {
  const source = await readFile("work/inspect-garden-dryrun.mjs", "utf8");
  assert.match(
    source,
    /async function requestSync\(ws, gsToken, iface, arg = \{\}, errorPrefix = iface, options = \{\}\)/,
  );
  assert.match(
    source,
    /ws\.request\(\s*iface,\s*arg,\s*gsToken,\s*options\.requestContext \|\| \{\}/s,
  );
  assert.match(
    source,
    /const tick = await requestSync\(ws, gsToken, "gs\.usr\.heartTick", \{\},/,
  );
  assert.match(source, /const onlineHeartTickIntervalMs = getOnlineHeartTickIntervalMs\(\)/);
  assert.match(source, /scheduler\.runDue\("onlineHeartbeat"/);
  assert.match(source, /task: \(\) => refreshOnlineState\(ws, gsToken, next, "loopHeartTick"/);
  assert.match(source, /if \(isSessionExpiredError\(err\) \|\| isWsRequestTimeoutError\(err\)\) throw err/);
  assert.match(source, /fs\.appendFileSync\(logPath,/);
  assert.match(source, /wrap\("log"\);\s*wrap\("warn"\);\s*wrap\("error"\);/s);
});

test("Task 1 baseline records deterministic artifact, read, lifecycle, request and log metrics offline", () => {
  const baseline = runOfflineRuntimeArtifactBaseline();
  assert.deepEqual(
    {
      buildCount: baseline.artifact.buildCount,
      logicalWriteBytes: baseline.artifact.logicalWriteBytes,
      actualReplaceCount: baseline.artifact.actualReplaceCount,
      maxQueueLength: baseline.artifact.maxQueueLength,
      fullReadCount: baseline.fullStatusRead.requestCount,
      fullReadFiles: baseline.fullStatusRead.fileCount,
      parseCount: baseline.fullStatusRead.parseCount,
      responseBytes: baseline.fullStatusRead.responseBytes,
      renderCount: baseline.fullStatusRead.renderCount,
      firstOpenReads: baseline.fullStatusRead.byTrigger["first-open"],
      lifecycleLatency: baseline.lifecycle.latenciesMs,
    },
    {
      buildCount: 3,
      logicalWriteBytes: 195,
      actualReplaceCount: 9,
      maxQueueLength: 1,
      fullReadCount: 1,
      fullReadFiles: 2,
      parseCount: 2,
      responseBytes: 256,
      renderCount: 1,
      firstOpenReads: 1,
      lifecycleLatency: [40],
    },
  );
});

test("baseline recorder separates retries, failures, duplicate events and lost events", () => {
  const recorder = createRuntimeArtifactBaseline({ profileId: "p1" });
  recorder.recordGameRequest({
    atMs: 10,
    iface: "gs.usr.heartTick",
    args: {},
    trigger: "online-heartbeat",
    attempt: 2,
    outcome: "failed",
    errorCategory: "network",
  });
  recorder.recordFullStatusRead({
    atMs: 20,
    trigger: "manual-refresh",
    files: ["garden-status.json"],
    parsedFiles: 0,
    responseBytes: 0,
    rendered: false,
  });
  recorder.recordLifecycleEvent({
    event: "worker-exit",
    emittedAtMs: 30,
    domVisibleAtMs: 30,
    duplicate: true,
    lost: true,
  });
  recorder.recordSystemLog({
    atMs: 40,
    level: "warn",
    step: "requestFailed",
    message: "offline fixture",
    raw: "stable-log-line\n",
  });

  const snapshot = recorder.snapshot();
  assert.equal(snapshot.profileId, "p1");
  assert.equal(snapshot.game.retryCount, 1);
  assert.deepEqual(snapshot.game.failures[0], snapshot.game.requests[0]);
  assert.equal(snapshot.fullStatusRead.byTrigger["manual-refresh"], 1);
  assert.equal(snapshot.fullStatusRead.renderCount, 0);
  assert.equal(snapshot.lifecycle.duplicateCount, 1);
  assert.equal(snapshot.lifecycle.lostCount, 1);
  assert.equal(snapshot.logs.logicalBytes, Buffer.byteLength("stable-log-line\n", "utf8"));
});
