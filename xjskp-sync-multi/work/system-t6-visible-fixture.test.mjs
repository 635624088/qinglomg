import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import test from "node:test";

import { startT6ProfileSettingsVisibleServer } from "./fixtures/t6-profile-settings-visible-server.mjs";

test("T6 visible fixture is loopback-only, defers settings, blocks business actions, and cleans up", async (t) => {
  const fixture = await startT6ProfileSettingsVisibleServer();
  const tempRoot = fixture.tempRoot;
  t.after(async () => fixture.close().catch(() => {}));

  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const session = await fetchJson(`${fixture.url}api/session`);
  assert.equal(session.status, 200);
  assert.equal(session.data.settingsProtocolVersion, 2);

  const legacyPage = await fetchText(`${fixture.url}__t6/legacy-page`);
  assert.equal(legacyPage.status, 200);
  assert.match(legacyPage.text, /legacyMutationButton/);
  assert.match(legacyPage.text, /body\.message/);

  const profiles = await fetchJson(`${fixture.url}api/profiles`);
  assert.equal(profiles.status, 200);
  assert.deepEqual(profiles.data.profiles.map((profile) => profile.id).sort(), ["p1", "p2"]);
  assert.ok(profiles.data.profiles.every((profile) => profile.runtimeSyncStatus === "synced"));

  const snapshot = await fetchJson(`${fixture.url}api/profiles/p1/settings`);
  const controlHeaders = {
    "content-type": "application/json",
    "x-t6-control-token": fixture.controlToken,
  };
  await fetchJson(`${fixture.url}__t6/arm`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ legacySessionProtocol: true }),
  });
  const legacySession = await fetchJson(`${fixture.url}api/session`);
  assert.equal(legacySession.status, 200);
  assert.equal(Object.hasOwn(legacySession.data, "settingsProtocolVersion"), false);
  await fetchJson(`${fixture.url}__t6/arm`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ legacySessionProtocol: false }),
  });
  await fetchJson(`${fixture.url}__t6/arm`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ holdNextMutation: true }),
  });
  const mutation = fetchJson(`${fixture.url}api/profiles/p1/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": session.data.token,
      "x-xjskp-settings-transaction-id": randomUUID(),
      "if-match": `"${snapshot.data.settingsEpoch}:${snapshot.data.settingsRevision}"`,
      origin: fixture.url.slice(0, -1),
      referer: fixture.url,
    },
    body: JSON.stringify({ experienceGuardThresholdPercent: 0.6 }),
  });
  await waitFor(async () => {
    const status = await fetchJson(`${fixture.url}__t6/status`, { headers: controlHeaders });
    return status.data.pending.includes("mutation");
  });
  await fetchJson(`${fixture.url}__t6/release`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ kind: "mutation" }),
  });
  assert.equal((await mutation).status, 200);

  const beforeDrop = await fetchJson(`${fixture.url}api/profiles/p1/settings`);
  await fetchJson(`${fixture.url}__t6/arm`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ dropNextMutationAfterCommit: true }),
  });
  await assert.rejects(fetchJson(`${fixture.url}api/profiles/p1/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": session.data.token,
      "x-xjskp-settings-transaction-id": randomUUID(),
      "if-match": `"${beforeDrop.data.settingsEpoch}:${beforeDrop.data.settingsRevision}"`,
      origin: fixture.url.slice(0, -1),
      referer: fixture.url,
    },
    body: JSON.stringify({ experienceGuardThresholdPercent: 0.7 }),
  }));
  const afterDrop = await fetchJson(`${fixture.url}api/profiles/p1/settings`);
  assert.equal(afterDrop.data.settings.experienceGuardThresholdPercent, 0.7);

  const failedTransactionId = randomUUID();
  await fetchJson(`${fixture.url}__t6/arm`, {
    method: "POST",
    headers: controlHeaders,
    body: JSON.stringify({ failNextMutation: true }),
  });
  const explicitFailure = await fetchJson(`${fixture.url}api/profiles/p1/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": session.data.token,
      "x-xjskp-settings-transaction-id": failedTransactionId,
      "if-match": `"${afterDrop.data.settingsEpoch}:${afterDrop.data.settingsRevision}"`,
      origin: fixture.url.slice(0, -1),
      referer: fixture.url,
    },
    body: JSON.stringify({ experienceGuardThresholdPercent: 0.8 }),
  });
  assert.equal(explicitFailure.status, 400);
  assert.equal(explicitFailure.data.error, "INVALID_PROFILE_SETTINGS");
  assert.equal(explicitFailure.data.transactionId, failedTransactionId);
  assert.equal(explicitFailure.data.commitState, "not-applied");

  const blocked = await fetchJson(`${fixture.url}api/profiles/p1/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-xjskp-session-token": session.data.token,
    },
    body: "{}",
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error, "T6_FIXTURE_ACTION_DISABLED");
  assert.deepEqual(fixture.safetyCounters(), { workerStarts: 0, externalGameCalls: 0 });

  await fixture.close();
  await assert.rejects(fs.access(tempRoot), { code: "ENOENT" });
});

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, data: await response.json() };
}

async function fetchText(url, options) {
  const response = await fetch(url, options);
  return { status: response.status, text: await response.text() };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for T6 fixture state");
}
