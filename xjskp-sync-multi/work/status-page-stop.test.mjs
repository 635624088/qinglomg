import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

import {
  clearStatusDocumentContextCache,
  finalizeUserStopped,
  writeStatusDocuments,
} from "./inspect-garden-dryrun.mjs";

test("stopped status HTML does not keep refresh, countdown, or timer subscriptions", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "xjskp-status-page-stop-"));
  const oldEnv = { ...process.env };
  const statusDir = tempRoot;
  const paths = {
    html: path.join(statusDir, "garden-status.html"),
    json: path.join(statusDir, "garden-status.json"),
    md: path.join(statusDir, "garden-status.md"),
  };
  Object.assign(process.env, {
    STATUS_DOC_DIR: statusDir,
    STATUS_HTML_PATH: paths.html,
    STATUS_JSON_PATH: paths.json,
    STATUS_MD_PATH: paths.md,
    PROFILE_ID: "task5-fixture",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_RECEIVE_CYCLIC_NOTE: "0",
  });
  t.after(async () => {
    process.env = oldEnv;
    await rm(tempRoot, { recursive: true, force: true });
  });

  const sync = {
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 1_000_000,
        nextExp: 10_000_000,
        bag: { 7: 99, 23001: 0 },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 2, cTime: "2026-06-16T00:00:00.000Z" },
      },
    },
    usrLandTot: { usrLand: { landMap: {} } },
  };

  await finalizeUserStopped(sync, { finalizeUserStop: async () => {} }, { cycle: 1 });

  const html = await readFile(paths.html, "utf8");
  const status = JSON.parse(await readFile(paths.json, "utf8"));
  assert.equal(status.summary.automationStopped.reason, "user-stopped");
  assert.doesNotMatch(html, /<meta\s+http-equiv="refresh"/i);
  assert.doesNotMatch(html, /setInterval\(tick,\s*1000\)/);
  assert.doesNotMatch(html, /querySelectorAll\("\.countdown"\)/);
});

test("running status HTML uses compact lifecycle status for its page-local subscription", async (t) => {
  const statusDir = await mkdtemp(path.join(os.tmpdir(), "xjskp-status-page-running-"));
  const previousEnv = new Map();
  const env = {
    STATUS_DOC_DIR: statusDir,
    STATUS_HTML_PATH: path.join(statusDir, "garden-status.html"),
    STATUS_JSON_PATH: path.join(statusDir, "garden-status.json"),
    STATUS_MD_PATH: path.join(statusDir, "garden-status.md"),
    PROFILE_ID: "test-profile",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_RECEIVE_CYCLIC_NOTE: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(statusDir, { recursive: true, force: true });
  });

  writeStatusDocuments({
    $usrTot: { data: { lvl: 40, lvlExp: 1_000_000, nextExp: 10_000_000, bag: { 7: 99, 23001: 0 } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 2, cTime: "2026-06-16T00:00:00.000Z" } } },
    usrLandTot: { usrLand: { landMap: {} } },
  }, { step: "startupReady", cycle: "startup", log: false });

  const html = await readFile(env.STATUS_HTML_PATH, "utf8");
  assert.match(html, /<meta http-equiv="refresh"/);
  assert.match(html, /const lifecycleUrl = "\/api\/profiles\/"/);
  assert.match(html, /encodeURIComponent\(profileId\)/);
  assert.match(html, /status\?full=0/);
  assert.doesNotMatch(html, /status\?full=1/);
  assert.match(html, /clearInterval\(countdownTimer\)/);
  assert.match(html, /clearInterval\(lifecycleTimer\)/);
  assert.match(html, /document\.querySelector\('meta\[http-equiv="refresh"\]'\)\?\.remove\(\)/);
});

test("loop refresh uses only cached display context while current sync remains authoritative", async (t) => {
  const statusDir = await mkdtemp(path.join(os.tmpdir(), "xjskp-status-context-cache-"));
  const oldEnv = { ...process.env };
  const paths = {
    html: path.join(statusDir, "garden-status.html"),
    json: path.join(statusDir, "garden-status.json"),
    md: path.join(statusDir, "garden-status.md"),
  };
  Object.assign(process.env, {
    STATUS_DOC_DIR: statusDir,
    STATUS_HTML_PATH: paths.html,
    STATUS_JSON_PATH: paths.json,
    STATUS_MD_PATH: paths.md,
    PROFILE_ID: "status-context-cache-test",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_RECEIVE_CYCLIC_NOTE: "0",
  });
  t.after(async () => {
    clearStatusDocumentContextCache(paths.json);
    process.env = oldEnv;
    await rm(statusDir, { recursive: true, force: true });
  });

  const sync = (waterDrop) => ({
    $usrTot: {
      data: {
        lvl: 40,
        lvlExp: 1_000_000,
        nextExp: 10_000_000,
        bag: { 7: waterDrop, 23001: 0 },
      },
    },
    cultivateTot: {
      cultivateMap: {
        23001: { flowerId: 23001, lvl: 2, cTime: "2026-06-16T00:00:00.000Z" },
      },
    },
    usrLandTot: { usrLand: { landMap: {} } },
  });
  const actionFlow = {
    mode: "cycle-action",
    flowText: "ACTION FLOW 84 to 40",
  };

  writeStatusDocuments(sync(84), {
    step: "cycleAction",
    summary: {
      waterDropFlow: actionFlow,
      lastActionWaterDropFlow: actionFlow,
    },
    log: false,
  });
  await writeFile(paths.json, "not-json", "utf8");

  writeStatusDocuments(sync(2), {
    step: "loopStatusRefresh",
    statusMode: "loop-refresh",
    cycle: 2,
    log: false,
  });

  const status = JSON.parse(await readFile(paths.json, "utf8"));
  assert.equal(status.summary.waterDropText, "2/65");
  assert.equal(status.lastActionWaterDropFlow.flowText, actionFlow.flowText);
  assert.equal(status.resources.waterDropFlow.mode, "loop-refresh-snapshot");
});

test("opened running status page clears both timers after compact status reports stop", async (t) => {
  const statusDir = await mkdtemp(path.join(os.tmpdir(), "xjskp-status-page-runtime-"));
  const previousEnv = new Map();
  const env = {
    STATUS_DOC_DIR: statusDir,
    STATUS_HTML_PATH: path.join(statusDir, "garden-status.html"),
    STATUS_JSON_PATH: path.join(statusDir, "garden-status.json"),
    STATUS_MD_PATH: path.join(statusDir, "garden-status.md"),
    PROFILE_ID: "test-profile",
    AUTO_HANDLE_MATERIAL_SHOP: "0",
    AUTO_HANDLE_FML_LAND: "0",
    AUTO_HANDLE_FREE_WATER: "0",
    AUTO_HANDLE_WATERWHEEL: "0",
    AUTO_SUBMIT_PALACE_ORDERS: "0",
    AUTO_SUBMIT_CUSTOMER_ORDERS: "0",
    AUTO_HANDLE_TEAM_ORDERS: "0",
    AUTO_HANDLE_FLOWER_RACK: "0",
    AUTO_HANDLE_PEARL: "0",
    AUTO_HANDLE_CYCLIC_STORY_ORDERS: "0",
    AUTO_RECEIVE_CYCLIC_NOTE: "0",
  };
  for (const [key, value] of Object.entries(env)) {
    previousEnv.set(key, process.env[key]);
    process.env[key] = value;
  }
  t.after(async () => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(statusDir, { recursive: true, force: true });
  });

  writeStatusDocuments({
    $usrTot: { data: { lvl: 40, lvlExp: 1_000_000, nextExp: 10_000_000, bag: { 7: 99, 23001: 0 } } },
    cultivateTot: { cultivateMap: { 23001: { flowerId: 23001, lvl: 2, cTime: "2026-06-16T00:00:00.000Z" } } },
    usrLandTot: { usrLand: { landMap: { 1: { landId: 1, flowerId: 23001, cTime: "2026-06-16T00:00:00.000Z" } } } },
  }, { step: "startupReady", cycle: "startup", log: false });
  const html = await readFile(env.STATUS_HTML_PATH, "utf8");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const landRow = { dataset: { nextMs: String(Date.now() + 60_000), mature: "0" }, textContent: "" };
  const refreshMeta = { removed: false, remove() { this.removed = true; } };
  const timers = [];
  const requests = [];
  const context = vm.createContext({
    Date,
    Math,
    Number,
    String,
    encodeURIComponent,
    document: {
      documentElement: { dataset: {} },
      querySelectorAll(selector) {
        assert.equal(selector, ".countdown");
        return [landRow];
      },
      querySelector(selector) {
        assert.equal(selector, 'meta[http-equiv="refresh"]');
        return refreshMeta;
      },
    },
    setInterval(callback, delay) {
      const timer = { active: true, callback, delay };
      timers.push(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer) timer.active = false;
    },
    fetch: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        async json() {
          return { summary: { risk: { automationStopped: { stopped: true, reason: "user-stopped" } } } };
        },
      };
    },
  });
  vm.runInContext(script, context);
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/profiles\/test-profile\/status\?full=0$/);
  assert.equal(requests[0].init.cache, "no-store");
  assert.equal(refreshMeta.removed, true);
  assert.equal(context.document.documentElement.dataset.statusLifecycle, "stopped");
  assert.equal(timers.filter((timer) => timer.active).length, 0);
  const frozenText = landRow.textContent;
  for (const timer of timers.filter((candidate) => candidate.delay === 1000 && candidate.active)) timer.callback();
  assert.equal(landRow.textContent, frozenText);
});
