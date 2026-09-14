import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { startTask4GameVersionVisibleServer } from "./fixtures/task4-game-version-visible-server.mjs";

test("Task4 visible fixture is loopback-only, isolated, deterministic, and cleans up", async (t) => {
  const fixture = await startTask4GameVersionVisibleServer({ scenario: "manual-review" });
  t.after(() => fixture.close().catch(() => {}));
  assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const page = await fetch(fixture.url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /syncGameDataButton/);
  const status = await fetch(`${fixture.url}api/system/game-version`).then((response) => response.json());
  assert.equal(status.code.reviewStatus, "pending-analysis");
  assert.equal(status.data.compatibilityStatus, "manual-review");
  assert.deepEqual(fixture.counters(), { externalGameCalls: 0, workerStarts: 0 });
  const tempRoot = fixture.tempRoot;
  await fixture.close();
  await assert.rejects(fs.access(tempRoot), { code: "ENOENT" });
});
