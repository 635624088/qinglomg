import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTimeAuthority,
  getTimeAuthoritySnapshot,
} from "./time-authority.mjs";
import {
  refreshOnlineState,
  writeStatusDocuments,
} from "./inspect-garden-dryrun.mjs?time-authority-test";

const LOCAL_EPOCH_MS = 1_700_000_000_000;

function serverMsForCandidate(responseAtMs, rttMs, deltaMs) {
  return responseAtMs + deltaMs - (rttMs / 2);
}

function acceptSample(authority, {
  startAtMs = LOCAL_EPOCH_MS,
  rttMs = 400,
  deltaMs = 2_000,
} = {}) {
  authority.beginHeartbeat(startAtMs);
  const responseAtMs = startAtMs + rttMs;
  return authority.recordHeartbeat({
    serverMs: serverMsForCandidate(responseAtMs, rttMs, deltaMs),
    responseAtMs,
  });
}

test("official heartbeat sample uses server ms plus half RTT and exposes corrected time", () => {
  const authority = createTimeAuthority({
    maxAgeMs: 10_000,
    nowFn: () => LOCAL_EPOCH_MS + 400,
  });

  const state = acceptSample(authority);

  assert.equal(state.trusted, true);
  assert.equal(state.rejectionReason, null);
  assert.equal(state.rttMs, 400);
  assert.equal(state.serverOffsetMs, 2_000);
  assert.equal(state.correctedNowMs, LOCAL_EPOCH_MS + 2_400);
  assert.equal(state.lastAcceptedSample.serverMs, LOCAL_EPOCH_MS + 2_200);
  assert.equal(state.lastAcceptedSample.correctedServerMs, LOCAL_EPOCH_MS + 2_400);
  assert.equal(state.lastAcceptedSample.rttMs, 400);
});

test("RTT accepts values below 1200 ms and rejects the exact 1200 ms boundary", () => {
  const accepted = createTimeAuthority({ maxAgeMs: 10_000 });
  const acceptedState = acceptSample(accepted, { rttMs: 1_199 });
  assert.equal(acceptedState.trusted, true);
  assert.equal(acceptedState.lastAttempt.rttMs, 1_199);

  const rejected = createTimeAuthority({ maxAgeMs: 10_000 });
  const rejectedState = acceptSample(rejected, { rttMs: 1_200 });
  assert.equal(rejectedState.trusted, false);
  assert.equal(rejectedState.rejectionReason, "rtt-too-high");
  assert.equal(rejectedState.lastAttempt.decision, "rtt-too-high");
  assert.equal(rejectedState.lastAcceptedSample, null);
});

test("fresh low-delta heartbeat trusts the server-validated local clock without applying an offset", () => {
  const below = createTimeAuthority({ maxAgeMs: 10_000 });
  const belowState = acceptSample(below, { deltaMs: 999 });
  assert.equal(belowState.trusted, true);
  assert.equal(belowState.rejectionReason, "no-correction-needed");
  assert.equal(belowState.lastAttempt.decision, "no-correction-needed");
  assert.equal(belowState.clockSource, "server-heartbeat-local-validated");
  assert.equal(belowState.serverOffsetMs, 0);
  assert.equal(belowState.correctedNowMs, LOCAL_EPOCH_MS + 400);
  assert.equal(belowState.lastAcceptedSample.serverMs, LOCAL_EPOCH_MS + 1_199);
  assert.equal(belowState.lastAcceptedSample.correctedServerMs, LOCAL_EPOCH_MS + 1_399);
  assert.equal(belowState.lastAcceptedSample.deltaMs, 999);
  assert.equal(belowState.lastAcceptedSample.source, "server-heartbeat-local-validated");
});

test("fresh real-world low-delta heartbeat trusts the local clock while retaining server evidence", () => {
  const authority = createTimeAuthority({ maxAgeMs: 10_000 });
  const responseAtMs = LOCAL_EPOCH_MS + 45;
  authority.beginHeartbeat(LOCAL_EPOCH_MS);
  const state = authority.recordHeartbeat({
    responseAtMs,
    serverMs: serverMsForCandidate(responseAtMs, 45, 99.5),
  });

  assert.equal(state.trusted, true);
  assert.equal(state.serverOffsetMs, 0);
  assert.equal(state.correctedNowMs, responseAtMs);
  assert.equal(state.lastAcceptedSample.rttMs, 45);
  assert.equal(state.lastAcceptedSample.correctedServerMs, responseAtMs + 99.5);
  assert.equal(state.lastAcceptedSample.deltaMs, 99.5);
  assert.equal(state.lastAttempt.decision, "no-correction-needed");
});

test("offset difference applies a correction at exactly 1000 ms", () => {
  const exact = createTimeAuthority({ maxAgeMs: 10_000 });
  const exactState = acceptSample(exact, { deltaMs: 1_000 });
  assert.equal(exactState.trusted, true);
  assert.equal(exactState.serverOffsetMs, 1_000);
});

test("fresh authority rejects high RTT, missing or invalid server time, and failed heartbeats", () => {
  const cases = [
    {
      name: "high RTT",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS);
        return authority.recordHeartbeat({
          responseAtMs: LOCAL_EPOCH_MS + 1_200,
          serverMs: serverMsForCandidate(LOCAL_EPOCH_MS + 1_200, 1_200, 99.5),
        });
      },
    },
    {
      name: "missing server time",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS);
        return authority.recordHeartbeat({ responseAtMs: LOCAL_EPOCH_MS + 45 });
      },
    },
    {
      name: "invalid server time",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS);
        return authority.recordHeartbeat({ responseAtMs: LOCAL_EPOCH_MS + 45, serverMs: "invalid" });
      },
    },
    {
      name: "failed heartbeat",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS);
        return authority.failHeartbeat(new Error("offline"), LOCAL_EPOCH_MS + 45);
      },
    },
  ];

  for (const expected of cases) {
    const state = expected.record(createTimeAuthority({ maxAgeMs: 10_000 }));
    assert.equal(state.trusted, false, expected.name);
    assert.equal(state.lastAcceptedSample, null, expected.name);
  }
});

test("valid low-delta heartbeats keep a retained baseline trusted across the sample age boundary", () => {
  const authority = createTimeAuthority({ maxAgeMs: 500 });
  authority.hardSync({
    serverMs: LOCAL_EPOCH_MS + 500,
    requestStartedAtMs: LOCAL_EPOCH_MS,
    responseAtMs: LOCAL_EPOCH_MS,
  });

  for (const responseAtMs of [LOCAL_EPOCH_MS + 400, LOCAL_EPOCH_MS + 800]) {
    authority.beginHeartbeat(responseAtMs - 400);
    const state = authority.recordHeartbeat({
      responseAtMs,
      serverMs: serverMsForCandidate(responseAtMs, 400, 500),
    });
    assert.equal(state.trusted, true);
    assert.equal(state.rejectionReason, "no-correction-needed");
    assert.equal(state.serverOffsetMs, 500);
  }
});

test("a valid low-delta heartbeat restores an expired retained baseline, but missing server time does not", () => {
  const restored = createTimeAuthority({ maxAgeMs: 500 });
  restored.hardSync({
    serverMs: LOCAL_EPOCH_MS + 500,
    requestStartedAtMs: LOCAL_EPOCH_MS,
    responseAtMs: LOCAL_EPOCH_MS,
  });
  restored.beginHeartbeat(LOCAL_EPOCH_MS + 400);
  const renewed = restored.recordHeartbeat({
    responseAtMs: LOCAL_EPOCH_MS + 800,
    serverMs: serverMsForCandidate(LOCAL_EPOCH_MS + 800, 400, 500),
  });
  assert.equal(renewed.trusted, true);
  assert.equal(renewed.serverOffsetMs, 500);

  const missing = createTimeAuthority({ maxAgeMs: 500 });
  missing.hardSync({
    serverMs: LOCAL_EPOCH_MS + 500,
    requestStartedAtMs: LOCAL_EPOCH_MS,
    responseAtMs: LOCAL_EPOCH_MS,
  });
  missing.beginHeartbeat(LOCAL_EPOCH_MS + 400);
  const failed = missing.recordHeartbeat({ responseAtMs: LOCAL_EPOCH_MS + 800 });
  assert.equal(failed.trusted, false);
  assert.equal(failed.rejectionReason, "sample-expired");
});

test("an expired large positive or negative offset cannot be revived by a low-delta heartbeat", () => {
  for (const staleOffsetMs of [60_000, -60_000]) {
    const authority = createTimeAuthority({ maxAgeMs: 500 });
    authority.hardSync({
      serverMs: LOCAL_EPOCH_MS + staleOffsetMs,
      requestStartedAtMs: LOCAL_EPOCH_MS,
      responseAtMs: LOCAL_EPOCH_MS,
    });
    const responseAtMs = LOCAL_EPOCH_MS + 800;
    authority.beginHeartbeat(responseAtMs - 400);
    const state = authority.recordHeartbeat({
      responseAtMs,
      serverMs: serverMsForCandidate(responseAtMs, 400, 500),
    });

    assert.equal(state.trusted, true, String(staleOffsetMs));
    assert.equal(state.serverOffsetMs, 500, String(staleOffsetMs));
    assert.equal(state.correctedNowMs, responseAtMs + 500, String(staleOffsetMs));
  }
});

test("expired authority is not restored by invalid, high-RTT, or failed heartbeats", () => {
  const cases = [
    {
      name: "invalid server time",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS + 400);
        return authority.recordHeartbeat({ responseAtMs: LOCAL_EPOCH_MS + 800, serverMs: "invalid" });
      },
    },
    {
      name: "RTT at the official rejection boundary",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS - 400);
        return authority.recordHeartbeat({
          responseAtMs: LOCAL_EPOCH_MS + 800,
          serverMs: serverMsForCandidate(LOCAL_EPOCH_MS + 800, 1_200, 500),
        });
      },
    },
    {
      name: "request failure",
      record(authority) {
        authority.beginHeartbeat(LOCAL_EPOCH_MS + 400);
        return authority.failHeartbeat(new Error("offline"), LOCAL_EPOCH_MS + 800);
      },
    },
  ];

  for (const expected of cases) {
    const authority = createTimeAuthority({ maxAgeMs: 500 });
    authority.hardSync({
      serverMs: LOCAL_EPOCH_MS + 500,
      requestStartedAtMs: LOCAL_EPOCH_MS,
      responseAtMs: LOCAL_EPOCH_MS,
    });
    const state = expected.record(authority);
    assert.equal(state.trusted, false, expected.name);
    assert.equal(state.rejectionReason, "sample-expired", expected.name);
  }
});

test("non-heartbeat server time establishes a hard-sync baseline without heartbeat gates", () => {
  const authority = createTimeAuthority({
    maxAgeMs: 10_000,
    nowFn: () => LOCAL_EPOCH_MS + 400,
  });
  const state = authority.hardSync({
    serverMs: LOCAL_EPOCH_MS + 60_000,
    requestStartedAtMs: LOCAL_EPOCH_MS,
    responseAtMs: LOCAL_EPOCH_MS + 400,
  });

  assert.equal(state.trusted, true);
  assert.equal(state.clockSource, "server-hard-sync");
  assert.equal(state.correctedNowMs, LOCAL_EPOCH_MS + 60_000);
  assert.equal(state.lastAcceptedSample.source, "server-hard-sync");
  assert.equal(state.lastAttempt.decision, "hard-sync-accepted");
});

test("missing and invalid server ms preserve the last accepted sample", () => {
  const authority = createTimeAuthority({
    maxAgeMs: 10_000,
    nowFn: () => LOCAL_EPOCH_MS + 1_000,
  });
  const accepted = acceptSample(authority);

  authority.beginHeartbeat(LOCAL_EPOCH_MS + 1_000);
  const missing = authority.recordHeartbeat({ responseAtMs: LOCAL_EPOCH_MS + 1_100 });
  assert.deepEqual(missing.lastAcceptedSample, accepted.lastAcceptedSample);
  assert.equal(missing.trusted, true);
  assert.equal(missing.rejectionReason, "missing-server-time");
  assert.equal(missing.lastAttempt.decision, "missing-server-time");
  assert.equal(missing.clockSource, "retained-server-baseline");

  authority.beginHeartbeat(LOCAL_EPOCH_MS + 1_200);
  const invalid = authority.recordHeartbeat({
    serverMs: "not-a-time",
    responseAtMs: LOCAL_EPOCH_MS + 1_300,
  });
  assert.deepEqual(invalid.lastAcceptedSample, accepted.lastAcceptedSample);
  assert.equal(invalid.trusted, true);
  assert.equal(invalid.rejectionReason, "invalid-server-time");
  assert.equal(invalid.lastAttempt.decision, "heartbeat-failed");
});

test("heartbeat failure keeps the last valid sample, while expiration removes trust", () => {
  const authority = createTimeAuthority({
    maxAgeMs: 500,
    nowFn: () => LOCAL_EPOCH_MS + 600,
  });
  const accepted = acceptSample(authority);

  authority.beginHeartbeat(LOCAL_EPOCH_MS + 500);
  const failed = authority.failHeartbeat(new Error("simulated heartbeat failure"), LOCAL_EPOCH_MS + 600);
  assert.deepEqual(failed.lastAcceptedSample, accepted.lastAcceptedSample);
  assert.equal(failed.rejectionReason, "heartbeat-failed");
  assert.equal(failed.lastAttempt.decision, "heartbeat-failed");
  assert.equal(failed.trusted, true);
  assert.equal(failed.correctedNowMs, LOCAL_EPOCH_MS + 2_600);

  const status = getTimeAuthoritySnapshot(accepted, {
    nowMs: LOCAL_EPOCH_MS + 901,
    maxAgeMs: 500,
  });
  assert.equal(status.trusted, false);
  assert.equal(status.rejectionReason, "sample-expired");
  assert.deepEqual(status.lastAcceptedSample, accepted.lastAcceptedSample);
  assert.equal(status.correctedNowMs, null);
});

test("an expired sample is not used as the corrected comparison clock", () => {
  const authority = createTimeAuthority({ maxAgeMs: 500 });
  const first = acceptSample(authority, {
    startAtMs: LOCAL_EPOCH_MS,
    rttMs: 400,
    deltaMs: 2_000,
  });
  assert.equal(first.trusted, true);

  authority.beginHeartbeat(LOCAL_EPOCH_MS + 2_000);
  const renewed = authority.recordHeartbeat({
    responseAtMs: LOCAL_EPOCH_MS + 2_400,
    serverMs: serverMsForCandidate(LOCAL_EPOCH_MS + 2_400, 400, 2_000),
  });

  assert.equal(renewed.trusted, true);
  assert.equal(renewed.rejectionReason, null);
  assert.equal(renewed.lastAcceptedSample.acceptedAtMs, LOCAL_EPOCH_MS + 2_400);
});

test("refreshOnlineState samples around the existing heartTick request and writes auditable state", async () => {
  let nowMs = LOCAL_EPOCH_MS;
  const calls = [];
  const ws = {
    async request(iface) {
      calls.push(iface);
      nowMs = LOCAL_EPOCH_MS + 400;
      return {
        v: {
          marker: "heartbeat-response",
          $other: {
            ms: serverMsForCandidate(nowMs, 400, 2_000),
          },
        },
      };
    },
  };

  const next = await refreshOnlineState(ws, "test-token", { marker: "before" }, "testHeartTick", {
    force: true,
    nowMs: LOCAL_EPOCH_MS,
    timeAuthorityNowFn: () => nowMs,
    timeAuthorityMaxAgeMs: 10_000,
  });

  assert.deepEqual(calls, ["gs.usr.heartTick"]);
  assert.equal(next.marker, "heartbeat-response");
  assert.equal(next.$timeAuthority.trusted, true);
  assert.equal(next.$timeAuthority.rttMs, 400);
  assert.equal(next.$timeAuthority.serverOffsetMs, 2_000);
  assert.equal(next.$timeAuthority.correctedNowMs, LOCAL_EPOCH_MS + 2_400);
  assert.equal(next.$timeAuthority.lastAcceptedSample.correctedServerMs, LOCAL_EPOCH_MS + 2_400);
  assert.equal(getTimeAuthoritySnapshot(next.$timeAuthority, { nowMs }).trusted, true);
});

test("refreshOnlineState trusts a fresh low-delta heartbeat without applying a server offset", async () => {
  let nowMs = LOCAL_EPOCH_MS;
  const next = await refreshOnlineState({
    async request() {
      nowMs = LOCAL_EPOCH_MS + 45;
      return {
        v: {
          $other: { ms: serverMsForCandidate(nowMs, 45, 99.5) },
        },
      };
    },
  }, "test-token", {}, "freshLowDeltaHeartTick", {
    force: true,
    nowMs: LOCAL_EPOCH_MS,
    timeAuthorityNowFn: () => nowMs,
    timeAuthorityMaxAgeMs: 10_000,
  });

  assert.equal(next.$timeAuthority.trusted, true);
  assert.equal(next.$timeAuthority.serverOffsetMs, 0);
  assert.equal(next.$timeAuthority.correctedNowMs, LOCAL_EPOCH_MS + 45);
  assert.equal(next.$timeAuthority.clockSource, "server-heartbeat-local-validated");
  assert.equal(next.$timeAuthority.lastAcceptedSample.deltaMs, 99.5);
});

test("refreshOnlineState rejects a missing $other.ms without replacing the prior sample", async () => {
  let nowMs = LOCAL_EPOCH_MS;
  const first = await refreshOnlineState({
    async request() {
      nowMs = LOCAL_EPOCH_MS + 400;
      return { v: { $other: { ms: serverMsForCandidate(nowMs, 400, 2_000) } } };
    },
  }, "test-token", {}, "sampleBeforeMissing", {
    force: true,
    nowMs: LOCAL_EPOCH_MS,
    timeAuthorityNowFn: () => nowMs,
    timeAuthorityMaxAgeMs: 10_000,
  });

  nowMs = LOCAL_EPOCH_MS + 800;
  const missing = await refreshOnlineState({
    async request() {
      return { v: { $other: {} } };
    },
  }, "test-token", first, "missingServerTime", {
    force: true,
    nowMs,
    timeAuthorityNowFn: () => nowMs,
    timeAuthorityMaxAgeMs: 10_000,
  });

  assert.deepEqual(
    missing.$timeAuthority.lastAcceptedSample,
    first.$timeAuthority.lastAcceptedSample,
  );
  assert.equal(missing.$timeAuthority.rejectionReason, "missing-server-time");
});

test("refreshOnlineState records a heartbeat failure without replacing the prior sample", async () => {
  let nowMs = LOCAL_EPOCH_MS;
  const firstWs = {
    async request() {
      nowMs = LOCAL_EPOCH_MS + 400;
      return { v: { $other: { ms: serverMsForCandidate(nowMs, 400, 2_000) } } };
    },
  };
  const first = await refreshOnlineState(firstWs, "test-token", {}, "firstHeartTick", {
    force: true,
    nowMs: LOCAL_EPOCH_MS,
    timeAuthorityNowFn: () => nowMs,
    timeAuthorityMaxAgeMs: 10_000,
  });

  nowMs = LOCAL_EPOCH_MS + 1_000;
  const failed = await refreshOnlineState({
    async request() {
      throw new Error("offline heartbeat");
    },
  }, "test-token", first, "failedHeartTick", {
    force: true,
    nowMs,
    timeAuthorityNowFn: () => nowMs,
    timeAuthorityMaxAgeMs: 10_000,
  });

  assert.deepEqual(
    failed.$timeAuthority.lastAcceptedSample,
    first.$timeAuthority.lastAcceptedSample,
  );
  assert.equal(failed.$timeAuthority.rejectionReason, "heartbeat-failed");
  assert.equal(failed.$timeAuthority.trusted, true);
});

test("status JSON exposes the time authority state without changing Date.now", () => {
  const originalDateNow = Date.now;
  const baseMs = Date.now();
  let nowMs = baseMs;
  const authority = createTimeAuthority({
    maxAgeMs: 60_000,
    nowFn: () => nowMs,
  });
  const state = acceptSample(authority, { startAtMs: baseMs - 400 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-time-authority-status-"));
  const envKeys = ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    writeStatusDocuments({ $timeAuthority: state }, { step: "timeAuthorityStatus", log: false });
    const status = JSON.parse(fs.readFileSync(process.env.STATUS_JSON_PATH, "utf8"));
    assert.deepEqual(status.timeAuthority.lastAcceptedSample, state.lastAcceptedSample);
    assert.deepEqual(status.summary.timeAuthority.lastAcceptedSample, state.lastAcceptedSample);
    assert.equal(status.timeAuthority.trusted, true);
    assert.equal(Date.now, originalDateNow);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] == null) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect-garden status uses the trusted corrected clock for land, water, and double gold", () => {
  const localNowMs = LOCAL_EPOCH_MS + 400;
  const serverNowMs = localNowMs + 60_000;
  const authority = createTimeAuthority({
    maxAgeMs: 10_000,
    nowFn: () => localNowMs,
  });
  const authorityState = acceptSample(authority, {
    startAtMs: LOCAL_EPOCH_MS,
    rttMs: 400,
    deltaMs: 60_000,
  });
  const sync = {
    $timeAuthority: authorityState,
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {
            state: 2,
            flowerId: 23001,
            nextTime: new Date(serverNowMs - 1_000).toISOString(),
          },
        },
      },
    },
    $usrTot: {
      data: {
        cTime: new Date(serverNowMs - 3_600_000).toISOString(),
        bag: { 7: 10 },
        itemExtMap: {
          7: { lems: serverNowMs - 90_000, cd: 60_000, resetNum: 65 },
        },
      },
    },
    videoDouble: { eTime: new Date(serverNowMs - 30_000).toISOString() },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-time-authority-garden-status-"));
  const envKeys = ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const originalDateNow = Date.now;
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    writeStatusDocuments(sync, {
      step: "trustedCorrectedGardenStatus",
      nowMs: localNowMs + 1_000,
      log: false,
    });
    const status = JSON.parse(fs.readFileSync(process.env.STATUS_JSON_PATH, "utf8"));

    assert.equal(status.summary.matureCount, 1);
    assert.equal(status.resources.waterDrop.count, 11);
    assert.equal(status.resources.doubleGold.active, false);
    assert.equal(status.timeAuthority.trusted, true);
    assert.equal(status.timeAuthority.correctedNowMs, serverNowMs + 1_000);
    assert.equal(Date.now, originalDateNow);
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] == null) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("inspect-garden status falls back to local time after the authority sample expires", () => {
  const sampleLocalNowMs = LOCAL_EPOCH_MS + 400;
  const expiredLocalNowMs = sampleLocalNowMs + 20_000;
  const serverNowMs = sampleLocalNowMs + 60_000;
  const authority = createTimeAuthority({
    maxAgeMs: 10_000,
    nowFn: () => sampleLocalNowMs,
  });
  const authorityState = acceptSample(authority, {
    startAtMs: LOCAL_EPOCH_MS,
    rttMs: 400,
    deltaMs: 60_000,
  });
  const sync = {
    $timeAuthority: authorityState,
    usrLandTot: {
      usrLand: {
        landMap: {
          1001: {
            state: 2,
            nextTime: new Date(serverNowMs - 1_000).toISOString(),
          },
        },
      },
    },
    $usrTot: {
      data: {
        bag: { 7: 10 },
        itemExtMap: {
          7: { lems: serverNowMs - 90_000, cd: 60_000, resetNum: 65 },
        },
      },
    },
    videoDouble: { eTime: new Date(serverNowMs - 30_000).toISOString() },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-time-authority-expired-status-"));
  const envKeys = ["STATUS_DOC_DIR", "STATUS_JSON_PATH", "STATUS_HTML_PATH", "STATUS_MD_PATH"];
  const previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    process.env.STATUS_DOC_DIR = dir;
    process.env.STATUS_JSON_PATH = path.join(dir, "garden-status.json");
    process.env.STATUS_HTML_PATH = path.join(dir, "garden-status.html");
    process.env.STATUS_MD_PATH = path.join(dir, "garden-status.md");
    writeStatusDocuments(sync, {
      step: "expiredAuthorityGardenStatus",
      nowMs: expiredLocalNowMs,
      log: false,
    });
    const status = JSON.parse(fs.readFileSync(process.env.STATUS_JSON_PATH, "utf8"));

    assert.equal(status.summary.matureCount, 0);
    assert.equal(status.resources.waterDrop.count, 10);
    assert.equal(status.resources.doubleGold.active, true);
    assert.equal(status.timeAuthority.trusted, false);
    assert.equal(status.timeAuthority.rejectionReason, "sample-expired");
  } finally {
    for (const key of envKeys) {
      if (previousEnv[key] == null) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
