import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createTeamOrderArchive,
  createTeamOrderRunId,
} from "./team-order-archive.mjs";

async function withTempDir(prefix, run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function readLedger(statusDir, runId) {
  return JSON.parse(
    await fs.readFile(path.join(statusDir, "team-orders", `${runId}.json`), "utf8"),
  );
}

function createFakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      timer.cleared = true;
    },
  };
}

function archiveOptions(statusDir, overrides = {}) {
  return {
    statusDir,
    profileId: "profile-1",
    uid: "uid-1",
    label: "测试账号",
    serverIdx: 7,
    runId: createTeamOrderRunId({
      profileId: "profile-1",
      uid: "uid-1",
      startTime: 1_000,
      activeTime: 900,
    }),
    now: () => new Date("2026-07-24T00:00:00.000Z"),
    ...overrides,
  };
}

test("createTeamOrderRunId is stable and safe archive segments are enforced", async () => {
  const identity = {
    profileId: "profile-1",
    uid: "uid-1",
    startTime: 1_000,
    activeTime: 900,
  };
  const first = createTeamOrderRunId(identity);
  const second = createTeamOrderRunId({ ...identity });
  const createdTimeFallback = createTeamOrderRunId({
    profileId: "profile-1",
    uid: "uid-1",
    startTime: 1_000,
    createdTime: 900,
  });

  assert.equal(first, second);
  assert.equal(first, createdTimeFallback);
  assert.equal(
    first,
    createTeamOrderRunId({ ...identity, activeTime: 123_456 }),
  );
  assert.match(first, /^[a-f0-9]{24}$/);
  assert.notEqual(first, createTeamOrderRunId({ ...identity, uid: "uid-2" }));

  assert.throws(
    () => createTeamOrderArchive(archiveOptions("C:\\status", { profileId: "../profile" })),
    /Invalid profileId/,
  );
  assert.throws(
    () => createTeamOrderArchive(archiveOptions("C:\\status", { runId: "../run" })),
    /Invalid runId/,
  );
});

test("archives stay inside the caller supplied account status directory", async () => {
  await withTempDir("team-order-account-isolation-", async (rootDir) => {
    const firstStatusDir = path.join(rootDir, "profile-1");
    const secondStatusDir = path.join(rootDir, "profile-2");
    const firstRunId = createTeamOrderRunId({
      profileId: "profile-1",
      uid: "uid-1",
      startTime: 1_000,
      activeTime: 900,
    });
    const secondRunId = createTeamOrderRunId({
      profileId: "profile-2",
      uid: "uid-2",
      startTime: 1_000,
      activeTime: 900,
    });
    const first = createTeamOrderArchive(
      archiveOptions(firstStatusDir, { runId: firstRunId }),
    );
    const second = createTeamOrderArchive(
      archiveOptions(secondStatusDir, {
        profileId: "profile-2",
        uid: "uid-2",
        runId: secondRunId,
      }),
    );

    await Promise.all([
      first.start({ trigger: "resident-board-50", initialOrderNum: 1 }),
      second.start({ trigger: "resident-board-100", initialOrderNum: 9 }),
    ]);
    await Promise.all([first.finish({ finalStatus: "completed" }), second.flush()]);

    assert.equal(
      (await readLedger(firstStatusDir, firstRunId)).profileId,
      "profile-1",
    );
    assert.equal(
      (await readLedger(secondStatusDir, secondRunId)).profileId,
      "profile-2",
    );
    await assert.rejects(
      fs.access(path.join(firstStatusDir, "team-orders", `${secondRunId}.json`)),
    );
    await assert.rejects(
      fs.access(path.join(secondStatusDir, "team-orders", `${firstRunId}.json`)),
    );
  });
});

test("start append finish writes one durable ledger with paid renew disabled", async () => {
  await withTempDir("team-order-lifecycle-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);

    await archive.start({
      trigger: "resident-board-50",
      initialOrderNum: 1,
    });
    await archive.append({
      action: "submit",
      status: "success",
      flowerId: 23001,
      flowerName: "白百合",
      need: 15,
      inventoryBefore: 20,
      inventoryAfter: 5,
      orderNumBefore: 1,
      orderNumAfter: 2,
    });
    await archive.finish({
      finalStatus: "completed",
      finalOrderNum: 2,
      multiplier: 3,
      reward: { coin: 500 },
    });

    const ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].sequence, 1);
    assert.equal(ledger.events[0].timestampMs, Date.parse("2026-07-24T00:00:00.000Z"));
    assert.equal(ledger.initialOrderNum, 1);
    assert.equal(ledger.finalOrderNum, 2);
    assert.equal(ledger.finalStatus, "completed");
    assert.equal(ledger.paidRenew, false);
    assert.match(ledger.htmlFile, new RegExp(`^team-order-[A-Za-z0-9_-]+-${options.runId}\\.html$`));
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(
      html,
      /<dt>保护花跳过次数<\/dt><dd>0<\/dd>/,
    );
  });
});

test("commit writes the completed JSON and HTML once without active-challenge files", async () => {
  await withTempDir("team-order-one-shot-", async (statusDir) => {
    const renames = [];
    const fileSystem = {
      ...fs,
      async rename(fromPath, toPath) {
        renames.push({ fromPath, toPath });
        return fs.rename(fromPath, toPath);
      },
    };
    const options = archiveOptions(statusDir, { fileSystem });
    const archive = createTeamOrderArchive(options);
    const archiveDir = path.join(statusDir, "team-orders");

    await assert.rejects(fs.access(archiveDir));

    await archive.commit({
      initial: {
        trigger: "resident-board-50",
        initialOrderNum: 1,
        startedAt: "2026-07-24T00:00:00.000Z",
      },
      events: [{
        action: "submit",
        status: "success",
        flowerId: 23001,
        flowerName: "白百合",
        need: 15,
        inventoryBefore: 20,
        inventoryAfter: 5,
        orderNumBefore: 1,
        orderNumAfter: 2,
        timestampMs: Date.parse("2026-07-24T00:00:00.250Z"),
      }],
      result: {
        finalStatus: "completed",
        finalOrderNum: 2,
        serverOrderNum: 2,
        completedOrderCount: 1,
        multiplier: 1.2,
        reward: {
          raw: { 11: 2_000, 2: 1_600 },
          calculated: {
            displayed: { 11: 481_700, 2: 644_600 },
          },
          items: [
            {
              itemId: 2,
              itemName: "经验",
              rawAmount: 1_600,
              displayedAmount: 644_600,
            },
            {
              itemId: 11,
              itemName: "金币",
              rawAmount: 2_000,
              displayedAmount: 481_700,
            },
          ],
          displayText: "经验 644,600；金币 481,700",
        },
        stopReason: "server-ended",
        paidRenewAvailable: true,
        paidRenewSkipped: true,
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    const jsonTarget = path.join(archiveDir, `${options.runId}.json`);
    const htmlTarget = path.join(archiveDir, ledger.htmlFile);
    assert.deepEqual(
      renames.map(({ toPath }) => toPath).sort(),
      [htmlTarget, jsonTarget].sort(),
    );
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.events[0].timestamp, "2026-07-24T00:00:00.250Z");
    assert.equal(ledger.finishedAt, "2026-07-24T00:00:00.000Z");
    assert.equal(ledger.serverOrderNum, 2);
    assert.equal(ledger.completedOrderCount, 1);
    assert.equal(ledger.paidRenewAvailable, true);
    assert.equal(ledger.paidRenewSkipped, true);
    assert.equal(ledger.paidRenew, false);
    assert.deepEqual(ledger.orderDetails, [{
      sequence: 1,
      eventSequence: 1,
      timestamp: "2026-07-24T00:00:00.250Z",
      orderNum: 1,
      orderNumAfter: 2,
      flowerId: 23001,
      flowerName: "白百合",
      need: 15,
      inventoryBefore: 20,
      inventoryAfter: 5,
      flowerConsumed: 15,
      action: "submit",
      actionText: "提交订单",
      status: "success",
      statusText: "成功",
      submitted: true,
      description: "",
      descriptionText: "",
    }]);
    const html = await fs.readFile(htmlTarget, "utf8");
    assert.match(html, /完成订单数/);
    assert.match(html, />1</);
    assert.match(html, /检测到并已跳过/);
    assert.doesNotMatch(html, /每轮订单与提交明细/);
    assert.doesNotMatch(html, /<th>处理后库存<\/th>/);
    assert.match(
      html,
      /<dt>开始时间<\/dt><dd>2026-07-24 08:00:00<\/dd>/,
    );
    assert.match(html, /<td>2026-07-24 08:00:00<\/td>/);
    assert.match(html, /<dt>持续时间<\/dt><dd>0秒<\/dd>/);
    assert.doesNotMatch(html, /2026-07-24T00:00:00/);
    assert.match(html, /白百合/);
    assert.match(html, /经验 64,4600；金币 48,1700/);
    assert.doesNotMatch(html, /经验 644,600；金币 481,700/);
    assert.match(html, /<td>提交订单<\/td>/);
    assert.match(html, /<td>成功<\/td>/);
  });
});

test("paid renewal audit fields survive commit and render confirmed yuanbao spend", async () => {
  await withTempDir("team-order-paid-renew-audit-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.commit({
      initial: {
        trigger: "resident-board-50",
        initialOrderNum: 1,
        startedAt: "2026-07-24T00:00:00.000Z",
      },
      events: [{
        action: "paid-renew",
        status: "success",
        reason: "server-confirmed",
        costItemId: 1,
        costAmount: 60,
        balanceBefore: 120,
        balanceAfter: 60,
        remainingNumBefore: 1,
        remainingNumAfter: 0,
        confirmationEvidence: [
          "remaining-num-decreased",
          "yuanbao-cost-debited",
        ],
        serverConfirmed: true,
      }],
      result: {
        finalStatus: "completed",
        stopReason: "server-ended",
        paidRenewAvailable: true,
        paidRenewSkipped: false,
        paidRenewPurchasedCount: 1,
        paidRenewConfirmedCost: 60,
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.paidRenewPurchasedCount, 1);
    assert.equal(ledger.paidRenewConfirmedCost, 60);
    assert.equal(ledger.paidRenew, true);
    assert.deepEqual({
      costItemId: ledger.events[0].costItemId,
      costAmount: ledger.events[0].costAmount,
      balanceBefore: ledger.events[0].balanceBefore,
      balanceAfter: ledger.events[0].balanceAfter,
      remainingNumBefore: ledger.events[0].remainingNumBefore,
      remainingNumAfter: ledger.events[0].remainingNumAfter,
      confirmationEvidence: ledger.events[0].confirmationEvidence,
      serverConfirmed: ledger.events[0].serverConfirmed,
    }, {
      costItemId: 1,
      costAmount: 60,
      balanceBefore: 120,
      balanceAfter: 60,
      remainingNumBefore: 1,
      remainingNumAfter: 0,
      confirmationEvidence: [
        "remaining-num-decreased",
        "yuanbao-cost-debited",
      ],
      serverConfirmed: true,
    });
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(html, /<dt>自动购买次数<\/dt><dd>1<\/dd>/);
    assert.match(html, /<dt>已确认元宝消耗<\/dt><dd>60<\/dd>/);
    assert.match(html, /<td>付费续单<\/td>/);
  });
});

test("inventory shortage stays separate from errors in the completed archive summary", async () => {
  await withTempDir("team-order-shortage-summary-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.commit({
      initial: {
        trigger: "resident-board-50",
        initialOrderNum: 1,
        startedAt: "2026-07-24T00:00:00.000Z",
      },
      events: [
        {
          action: "submit",
          status: "success",
          flowerId: 23001,
          flowerName: "白百合",
          need: 15,
          inventoryBefore: 20,
          inventoryAfter: 5,
          flowerConsumed: 15,
          orderNumBefore: 1,
          orderNumAfter: 2,
        },
        {
          action: "inventory-shortage",
          status: "failure",
          inventoryShortage: true,
          flowerId: 23002,
          flowerName: "粉玫瑰",
          need: 30,
          inventoryBefore: 10,
          inventoryAfter: 10,
          orderNumBefore: 2,
          orderNumAfter: 2,
        },
        {
          action: "refresh",
          status: "success",
          flowerId: 23002,
          flowerName: "粉玫瑰",
          need: 30,
          inventoryBefore: 10,
          inventoryAfter: 18,
          orderNumBefore: 2,
          orderNumAfter: 2,
        },
      ],
      result: {
        finalStatus: "completed",
        finalOrderNum: 3,
        serverOrderNum: 3,
        completedOrderCount: 2,
        multiplier: 1,
        reward: null,
        stopReason: "server-ended",
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(html, /<dt>成功提交<\/dt><dd>1<\/dd>/);
    assert.match(html, /<dt>库存不足<\/dt><dd>1<\/dd>/);
    assert.match(html, /<dt>刷新次数<\/dt><dd>1<\/dd>/);
    assert.match(html, /<dt>失败次数<\/dt><dd>0<\/dd>/);
    assert.match(html, /<dt>累计消耗鲜花<\/dt><dd>15<\/dd>/);
    assert.equal(ledger.orderDetails.length, 3);
    assert.equal(ledger.orderDetails[1].actionText, "库存不足");
    assert.equal(ledger.orderDetails[1].statusText, "失败");
    assert.equal(ledger.orderDetails[1].descriptionText, "库存不足");
    assert.doesNotMatch(html, /<th>处理结果<\/th>/);
    assert.match(
      html,
      /<th>操作<\/th><th>状态<\/th><th>说明<\/th>/,
    );
    assert.match(html, /<td>刷新订单<\/td>/);
    assert.match(html, /<td>库存不足<\/td>/);
    assert.doesNotMatch(html, /<td>inventory-shortage<\/td>/);
    assert.doesNotMatch(html, /<td>insufficient-inventory<\/td>/);
  });
});

test("structured business errors keep their code parameters and sync schema", async () => {
  await withTempDir("team-order-structured-error-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.commit({
      initial: {
        trigger: "structured-error",
        initialOrderNum: 64,
        startedAt: "2026-08-03T03:15:51.000Z",
      },
      events: [{
        action: "failure",
        status: "server-rejected",
        reason: "submit",
        error: {
          code: 301,
          param: { iid: 23_090 },
          schema: "G.ISyncData",
        },
      }],
      result: {
        finalStatus: "completed",
        finalOrderNum: 64,
        serverOrderNum: 64,
        completedOrderCount: 63,
        multiplier: 1,
        reward: null,
        stopReason: "server-ended",
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    assert.deepEqual(ledger.events[0].error, {
      code: 301,
      param: { iid: 23_090 },
      schema: "G.ISyncData",
    });
  });
});

test("each append atomically writes JSON and schedules one 225ms HTML refresh", async () => {
  await withTempDir("team-order-atomic-", async (statusDir) => {
    const writes = [];
    const renames = [];
    const fileSystem = {
      ...fs,
      async writeFile(filePath, content, encoding) {
        writes.push({ filePath, content: String(content), encoding });
        return fs.writeFile(filePath, content, encoding);
      },
      async rename(fromPath, toPath) {
        renames.push({ fromPath, toPath });
        return fs.rename(fromPath, toPath);
      },
    };
    const fakeTimers = createFakeTimers();
    const options = archiveOptions(statusDir, { fileSystem, ...fakeTimers });
    const archive = createTeamOrderArchive(options);
    await archive.start({ trigger: "startup", initialOrderNum: 1 });
    writes.length = 0;
    renames.length = 0;

    await archive.append({ action: "submit", status: "success", orderNumBefore: 1 });
    await archive.append({ action: "refresh", status: "success", orderNumBefore: 2 });

    const jsonTarget = path.join(statusDir, "team-orders", `${options.runId}.json`);
    const jsonRenames = renames.filter(({ toPath }) => toPath === jsonTarget);
    assert.equal(jsonRenames.length, 2);
    assert.notEqual(jsonRenames[0].fromPath, jsonRenames[1].fromPath);
    assert.ok(jsonRenames.every(({ fromPath }) => fromPath.endsWith(".tmp")));
    const jsonSnapshots = writes
      .filter(({ filePath }) => filePath.endsWith(".tmp") && filePath.includes(`${options.runId}.json.`))
      .map(({ content }) => JSON.parse(content));
    assert.deepEqual(jsonSnapshots.map((ledger) => ledger.events.length), [1, 2]);
    assert.equal(fakeTimers.timers.length, 1);
    assert.equal(fakeTimers.timers[0].delay, 225);

    fakeTimers.timers[0].callback();
    await archive.flush();
    const htmlWrites = writes.filter(({ content }) => content.startsWith("<!doctype html>"));
    assert.ok(htmlWrites.some(({ content }) => content.includes("提交订单")));
    assert.ok(htmlWrites.some(({ content }) => content.includes("刷新订单")));
  });
});

test("finish and flush are idempotent and force the final HTML after queued appends", async () => {
  await withTempDir("team-order-final-flush-", async (statusDir) => {
    const fakeTimers = createFakeTimers();
    const options = archiveOptions(statusDir, fakeTimers);
    const archive = createTeamOrderArchive(options);
    await archive.start({ trigger: "startup", initialOrderNum: 1 });

    const appendPromise = archive.append({
      action: "submit",
      status: "success",
      orderNumBefore: 1,
      orderNumAfter: 2,
    });
    const finishPromise = archive.finish({
      finalStatus: "completed",
      finalOrderNum: 2,
      stopReason: "server-ended",
    });
    await Promise.all([appendPromise, finishPromise]);
    const firstLedger = await readLedger(statusDir, options.runId);
    const firstFinishedAt = firstLedger.finishedAt;

    await archive.finish({
      finalStatus: "ignored-second-finish",
      finalOrderNum: 99,
    });
    await archive.flush();
    await archive.flush();

    const ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.finishedAt, firstFinishedAt);
    assert.equal(ledger.finalStatus, "completed");
    assert.equal(ledger.finalOrderNum, 2);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(html, /completed/);
    assert.match(html, /server-ended/);
    assert.match(html, /提交订单/);
  });
});

test("starting the same runId resumes its JSON ledger and appends in sequence", async () => {
  await withTempDir("team-order-resume-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const first = createTeamOrderArchive(options);
    await first.start({ trigger: "startup", initialOrderNum: 4 });
    await first.append({
      action: "restore",
      status: "success",
      orderNumBefore: 4,
      orderNumAfter: 4,
    });
    await first.flush();
    const before = await readLedger(statusDir, options.runId);

    const second = createTeamOrderArchive(
      archiveOptions(statusDir, {
        runId: options.runId,
        now: () => new Date("2026-07-24T00:00:10.000Z"),
      }),
    );
    await second.start({ trigger: "must-not-replace", initialOrderNum: 99 });
    await second.append({
      action: "submit",
      status: "success",
      orderNumBefore: 4,
      orderNumAfter: 5,
    });
    await second.finish({ finalStatus: "completed", finalOrderNum: 5 });

    const ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.trigger, "startup");
    assert.equal(ledger.initialOrderNum, 4);
    assert.equal(ledger.htmlFile, before.htmlFile);
    assert.deepEqual(
      ledger.events.map(({ sequence, action }) => [sequence, action]),
      [
        [1, "restore"],
        [2, "submit"],
      ],
    );
  });
});

test("completed archive summary displays the protected flower skip count", async () => {
  await withTempDir("team-order-protected-flower-summary-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.commit({
      initial: {
        trigger: "special-order-submitted",
        initialOrderNum: 1,
        startedAt: "2026-07-29T00:00:00.000Z",
      },
      events: [
        {
          action: "protected-flower",
          status: "skipped",
          flowerId: 23_088,
          flowerName: "曼珠沙华",
          reason: "protected-flower-refresh",
        },
        {
          action: "refresh",
          status: "success",
          flowerId: 23_088,
          flowerName: "曼珠沙华",
        },
        {
          action: "protected-flower",
          status: "skipped",
          flowerId: 23_092,
          flowerName: "伯利恒之星",
          reason: "protected-flower-refresh",
        },
      ],
      result: {
        finalStatus: "completed",
        finalOrderNum: 1,
        stopReason: "server-ended",
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );

    assert.match(
      html,
      /<dt>保护花跳过次数<\/dt><dd>2<\/dd>/,
    );
  });
});

test("archive resolves historical flower names by id without rewriting raw events", async () => {
  await withTempDir("team-order-flower-name-backfill-", async (statusDir) => {
    const options = archiveOptions(statusDir, {
      flowerNames: {
        23_584: "辉似朝阳",
        23_589: "青绿四照花",
      },
    });
    const archive = createTeamOrderArchive(options);
    await archive.commit({
      initial: {
        trigger: "special-order-submitted",
        initialOrderNum: 47,
        startedAt: "2026-07-29T01:57:19.000Z",
      },
      events: [
        {
          action: "inventory-shortage",
          status: "failure",
          flowerId: 23_584,
          flowerName: null,
          need: 60,
          inventoryBefore: 0,
        },
        {
          action: "refresh",
          status: "success",
          flowerId: 23_589,
          flowerName: "风铃花",
          need: 60,
          inventoryBefore: 0,
        },
      ],
      result: {
        finalStatus: "completed",
        finalOrderNum: 47,
        stopReason: "server-ended",
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );

    assert.equal(ledger.events[0].flowerName, null);
    assert.equal(ledger.events[1].flowerName, "风铃花");
    assert.deepEqual(
      ledger.orderDetails.map((detail) => detail.flowerName),
      ["辉似朝阳", "青绿四照花"],
    );
    assert.match(html, /辉似朝阳 \(#23584\)/);
    assert.match(html, /青绿四照花 \(#23589\)/);
    assert.doesNotMatch(html, /— \(#23584\)/);
    assert.doesNotMatch(html, /风铃花 \(#23589\)/);
  });
});

test("self-contained HTML escapes every rendered dynamic field and includes summary plus nine columns", async () => {
  await withTempDir("team-order-html-", async (statusDir) => {
    const marker = `<bad&"' >`;
    const options = archiveOptions(statusDir, {
      uid: `uid-${marker}`,
      label: `label-${marker}`,
      serverIdx: `server-${marker}`,
    });
    const archive = createTeamOrderArchive(options);
    await archive.start({
      trigger: `trigger-${marker}`,
      initialOrderNum: 1,
    });
    await archive.append({
      action: `action-${marker}`,
      status: `status-${marker}`,
      flowerId: `flower-id-${marker}`,
      flowerName: `flower-name-${marker}`,
      need: `need-${marker}`,
      inventoryBefore: `inventory-${marker}`,
      orderNumBefore: `before-${marker}`,
      orderNumAfter: `after-${marker}`,
      message: `message-${marker}`,
    });
    await archive.append({
      action: "submit",
      status: "success",
      flowerId: 23001,
      flowerName: "白百合",
      need: 15,
      inventoryBefore: 20,
      inventoryAfter: 5,
      orderNumBefore: 1,
      orderNumAfter: 2,
    });
    await archive.append({
      action: "inventory-shortage",
      status: "failure",
      need: 30,
      inventoryBefore: 2,
      error: `error-${marker}`,
    });
    await archive.append({ action: "refresh", status: "success" });
    await archive.finish({
      finalStatus: `final-${marker}`,
      finalOrderNum: 2,
      multiplier: `multiplier-${marker}`,
      reward: { text: `reward-${marker}` },
      stopReason: `reason-${marker}`,
    });

    const ledger = await readLedger(statusDir, options.runId);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.ok(!html.includes(marker));
    assert.match(html, /&lt;bad&amp;&quot;&#39; &gt;/);
    assert.ok(!/<script[\s>]/i.test(html));
    assert.ok(!/<link[\s>]/i.test(html));
    assert.ok(!/https?:\/\//i.test(html));
    for (const heading of [
      "序号",
      "时间",
      "订单进度",
      "花朵",
      "数量",
      "提交前库存",
      "操作",
      "状态",
      "说明",
    ]) {
      assert.match(html, new RegExp(`<th>${heading}</th>`));
    }
    for (const summaryLabel of [
      "账号",
      "区服",
      "触发来源",
      "开始时间",
      "结束时间",
      "持续时间",
      "初始订单号",
      "最终订单号",
      "成功提交",
      "库存不足",
      "刷新次数",
      "失败次数",
      "累计消耗鲜花",
      "最终倍率",
      "奖励",
      "最终状态",
      "停止原因",
      "付费续单",
    ]) {
      assert.match(html, new RegExp(summaryLabel));
    }
    assert.match(html, /成功提交<\/dt><dd>1/);
    assert.match(html, /库存不足<\/dt><dd>1/);
    assert.match(html, /刷新次数<\/dt><dd>1/);
    assert.match(html, /失败次数<\/dt><dd>0/);
    assert.match(html, /累计消耗鲜花<\/dt><dd>15/);
    assert.match(html, /付费续单<\/dt><dd>否/);
  });
});

test("an HTML write failure is recorded and later append plus flush still succeed", async () => {
  await withTempDir("team-order-html-failure-", async (statusDir) => {
    let failNextHtmlRename = true;
    const fileSystem = {
      ...fs,
      async rename(fromPath, toPath) {
        if (failNextHtmlRename && toPath.endsWith(".html")) {
          failNextHtmlRename = false;
          throw new Error("simulated html rename failure");
        }
        return fs.rename(fromPath, toPath);
      },
    };
    const fakeTimers = createFakeTimers();
    const options = archiveOptions(statusDir, { fileSystem, ...fakeTimers });
    const archive = createTeamOrderArchive(options);

    await archive.start({ trigger: "startup", initialOrderNum: 1 });
    let ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.archiveErrors.length, 1);
    assert.match(ledger.archiveErrors[0].message, /simulated html rename failure/);

    await archive.append({
      action: "submit",
      status: "success",
      orderNumBefore: 1,
      orderNumAfter: 2,
    });
    await archive.flush();

    ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.events.length, 1);
    assert.equal(ledger.archiveErrors.length, 1);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(html, /提交订单/);
  });
});

test("concurrent appends preserve call order and a JSON write failure does not poison the queue", async () => {
  await withTempDir("team-order-json-failure-", async (statusDir) => {
    const fakeTimers = createFakeTimers();
    const options = archiveOptions(statusDir);
    const jsonTarget = path.join(statusDir, "team-orders", `${options.runId}.json`);
    let failNextJsonRename = false;
    let activeJsonRenames = 0;
    let maximumActiveJsonRenames = 0;
    const fileSystem = {
      ...fs,
      async rename(fromPath, toPath) {
        if (toPath === jsonTarget) {
          activeJsonRenames += 1;
          maximumActiveJsonRenames = Math.max(
            maximumActiveJsonRenames,
            activeJsonRenames,
          );
          try {
            if (failNextJsonRename) {
              failNextJsonRename = false;
              throw new Error("simulated JSON rename failure");
            }
            await new Promise((resolve) => setImmediate(resolve));
          } finally {
            activeJsonRenames -= 1;
          }
        }
        return fs.rename(fromPath, toPath);
      },
    };
    const archive = createTeamOrderArchive({
      ...options,
      fileSystem,
      ...fakeTimers,
    });
    await archive.start({ trigger: "startup", initialOrderNum: 1 });
    failNextJsonRename = true;

    const first = archive.append({ action: "first", status: "success" });
    const second = archive.append({ action: "second", status: "success" });
    const finish = archive.finish({ finalStatus: "completed", finalOrderNum: 3 });
    const results = await Promise.allSettled([first, second, finish]);

    assert.equal(results[0].status, "rejected");
    assert.match(results[0].reason.message, /simulated JSON rename failure/);
    assert.equal(results[1].status, "fulfilled");
    assert.equal(results[2].status, "fulfilled");
    assert.equal(maximumActiveJsonRenames, 1);
    let ledger = await readLedger(statusDir, options.runId);
    assert.deepEqual(
      ledger.events.map(({ sequence, action }) => [sequence, action]),
      [
        [1, "first"],
        [2, "second"],
      ],
    );
    assert.equal(ledger.finalStatus, "completed");

    await archive.append({ action: "third", status: "success" });
    await archive.flush();
    ledger = await readLedger(statusDir, options.runId);
    assert.deepEqual(
      ledger.events.map(({ action }) => action),
      ["first", "second", "third"],
    );
  });
});

test("retrying start after a transient JSON failure persists the existing ledger", async () => {
  await withTempDir("team-order-start-retry-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const jsonTarget = path.join(statusDir, "team-orders", `${options.runId}.json`);
    let failNextJsonRename = true;
    const fileSystem = {
      ...fs,
      async rename(fromPath, toPath) {
        if (failNextJsonRename && toPath === jsonTarget) {
          failNextJsonRename = false;
          throw new Error("simulated start JSON rename failure");
        }
        return fs.rename(fromPath, toPath);
      },
    };
    const archive = createTeamOrderArchive({ ...options, fileSystem });

    await assert.rejects(
      archive.start({ trigger: "startup", initialOrderNum: 1 }),
      /simulated start JSON rename failure/,
    );
    await archive.start({ trigger: "must-not-replace", initialOrderNum: 99 });

    const ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.trigger, "startup");
    assert.equal(ledger.initialOrderNum, 1);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(html, /startup/);
    assert.match(html, /进行中/);
  });
});

test("retrying finish after a transient JSON failure persists the final ledger", async () => {
  await withTempDir("team-order-finish-retry-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const jsonTarget = path.join(statusDir, "team-orders", `${options.runId}.json`);
    let failNextJsonRename = false;
    const fileSystem = {
      ...fs,
      async rename(fromPath, toPath) {
        if (failNextJsonRename && toPath === jsonTarget) {
          failNextJsonRename = false;
          throw new Error("simulated finish JSON rename failure");
        }
        return fs.rename(fromPath, toPath);
      },
    };
    const archive = createTeamOrderArchive({ ...options, fileSystem });
    await archive.start({ trigger: "startup", initialOrderNum: 1 });
    failNextJsonRename = true;

    await assert.rejects(
      archive.finish({
        finalStatus: "completed",
        finalOrderNum: 2,
        stopReason: "server-ended",
      }),
      /simulated finish JSON rename failure/,
    );
    await archive.finish({
      finalStatus: "ignored-retry-payload",
      finalOrderNum: 99,
    });

    const ledger = await readLedger(statusDir, options.runId);
    assert.equal(ledger.finalStatus, "completed");
    assert.equal(ledger.finalOrderNum, 2);
    assert.equal(ledger.stopReason, "server-ended");
    assert.ok(ledger.finishedAt);
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    assert.match(html, /completed/);
    assert.match(html, /server-ended/);
  });
});

test("resuming a run rejects a ledger that belongs to another uid", async () => {
  await withTempDir("team-order-resume-uid-mismatch-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const first = createTeamOrderArchive(options);
    await first.start({ trigger: "startup", initialOrderNum: 1 });
    await first.flush();

    const mismatched = createTeamOrderArchive(
      archiveOptions(statusDir, {
        runId: options.runId,
        uid: "uid-2",
      }),
    );
    await assert.rejects(
      mismatched.start({ trigger: "resume", initialOrderNum: 1 }),
      /Archive identity mismatch/,
    );
  });
});

test("append inputs, append results, and finish rewards are immutable JSON snapshots", async () => {
  await withTempDir("team-order-deep-snapshot-", async (statusDir) => {
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.start({ trigger: "startup", initialOrderNum: 1 });

    const inputError = {
      message: "safe original error",
      code: "E_ORIGINAL",
      context: { attempt: 1 },
    };
    const appended = await archive.append({
      action: "submit",
      status: "failure",
      flowerName: "白百合",
      error: inputError,
    });
    inputError.message = "mutated input error";
    inputError.context.attempt = 2;
    appended.error.message = "mutated returned error";
    appended.error.context.attempt = 3;

    const reward = {
      coin: 500,
      items: [{ id: 23001, count: 2 }],
    };
    await archive.finish({
      finalStatus: "completed",
      finalOrderNum: 2,
      reward,
    });
    reward.coin = 999;
    reward.items[0].count = 99;
    await archive.flush();

    const ledger = await readLedger(statusDir, options.runId);
    assert.deepEqual(ledger.events[0].error, {
      message: "safe original error",
      code: "E_ORIGINAL",
      context: { attempt: 1 },
    });
    assert.deepEqual(ledger.reward, {
      coin: 500,
      items: [{ id: 23001, count: 2 }],
    });
  });
});

test("credentials and unknown event fields never enter JSON or HTML archives", async () => {
  await withTempDir("team-order-sensitive-data-", async (statusDir) => {
    const secrets = [
      "label-password-secret",
      "server-cookie-secret",
      "trigger-token-secret",
      "event-token-secret",
      "payload-cookie-secret",
      "error-authorization-secret",
      "error-session-secret",
      "reward-password-secret",
      "reward-login-secret",
      "stop-token-secret",
    ];
    const options = archiveOptions(statusDir, {
      label: {
        displayName: "安全账号",
        password: secrets[0],
      },
      serverIdx: {
        value: 7,
        cookie: secrets[1],
      },
    });
    const archive = createTeamOrderArchive(options);
    await archive.start({
      trigger: {
        source: "startup",
        token: secrets[2],
      },
      initialOrderNum: 1,
    });
    await archive.append({
      action: "submit",
      status: "failure",
      flowerName: "白百合",
      token: secrets[3],
      payload: {
        cookie: secrets[4],
      },
      error: {
        message: "safe failure",
        authorization: secrets[5],
        nested: {
          session: secrets[6],
        },
      },
    });
    await archive.finish({
      finalStatus: "completed",
      finalOrderNum: 2,
      reward: {
        coin: 500,
        password: secrets[7],
        nested: {
          loginCredential: secrets[8],
        },
      },
      stopReason: {
        message: "safe stop",
        token: secrets[9],
      },
    });

    const ledger = await readLedger(statusDir, options.runId);
    const json = await fs.readFile(
      path.join(statusDir, "team-orders", `${options.runId}.json`),
      "utf8",
    );
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    for (const secret of secrets) {
      assert.ok(!json.includes(secret), `JSON leaked ${secret}`);
      assert.ok(!html.includes(secret), `HTML leaked ${secret}`);
    }
    assert.equal(Object.hasOwn(ledger.events[0], "token"), false);
    assert.equal(Object.hasOwn(ledger.events[0], "payload"), false);
    assert.equal(ledger.events[0].error.message, "safe failure");
    assert.equal(ledger.reward.coin, 500);
    assert.match(html, /安全账号/);
    assert.match(html, /safe failure/);
  });
});

test("textual credential markers redact complete values in JSON and HTML", async () => {
  await withTempDir("team-order-text-redaction-", async (statusDir) => {
    const secrets = [
      "PROBE_AUTH_SECRET",
      "PROBE_COOKIE_A",
      "PROBE_COOKIE_B",
      "PROBE_PASSWORD_SECRET",
    ];
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.start({
      trigger: "authorization: Bearer PROBE_AUTH_SECRET",
      initialOrderNum: 1,
    });
    await archive.append({
      action: "submit",
      status: "success",
      flowerName: "白百合",
      error: {
        message: "cookie: SID=PROBE_COOKIE_A; XSRF=PROBE_COOKIE_B",
      },
    });
    await archive.finish({
      finalStatus: "completed",
      finalOrderNum: 2,
      stopReason: "password: two word PROBE_PASSWORD_SECRET",
    });

    const ledger = await readLedger(statusDir, options.runId);
    const json = await fs.readFile(
      path.join(statusDir, "team-orders", `${options.runId}.json`),
      "utf8",
    );
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    for (const secret of secrets) {
      assert.ok(!json.includes(secret), `JSON leaked ${secret}`);
      assert.ok(!html.includes(secret), `HTML leaked ${secret}`);
    }
    assert.equal(ledger.trigger, "[REDACTED]");
    assert.equal(ledger.events[0].error.message, "[REDACTED]");
    assert.equal(ledger.stopReason, "[REDACTED]");
    assert.equal(ledger.events[0].flowerName, "白百合");
    assert.equal(ledger.events[0].status, "success");
  });
});

test("space-separated credential markers redact complete values in JSON and HTML", async () => {
  await withTempDir("team-order-space-redaction-", async (statusDir) => {
    const secrets = [
      "SPACE_AUTH_SECRET",
      "SPACE_COOKIE_SID",
      "SPACE_COOKIE_XSRF",
      "SPACE_PASSWORD_SECRET",
    ];
    const options = archiveOptions(statusDir);
    const archive = createTeamOrderArchive(options);
    await archive.start({
      trigger: "Authorization Bearer SPACE_AUTH_SECRET",
      initialOrderNum: 1,
    });
    await archive.append({
      action: "submit",
      status: "success",
      flowerName: "白百合",
      error: {
        message: "cookie SID=SPACE_COOKIE_SID; XSRF=SPACE_COOKIE_XSRF",
      },
    });
    await archive.finish({
      finalStatus: "completed",
      finalOrderNum: 2,
      stopReason: "password two word SPACE_PASSWORD_SECRET",
    });

    const ledger = await readLedger(statusDir, options.runId);
    const json = await fs.readFile(
      path.join(statusDir, "team-orders", `${options.runId}.json`),
      "utf8",
    );
    const html = await fs.readFile(
      path.join(statusDir, "team-orders", ledger.htmlFile),
      "utf8",
    );
    for (const secret of secrets) {
      assert.ok(!json.includes(secret), `JSON leaked ${secret}`);
      assert.ok(!html.includes(secret), `HTML leaked ${secret}`);
    }
    assert.equal(ledger.trigger, "[REDACTED]");
    assert.equal(ledger.events[0].error.message, "[REDACTED]");
    assert.equal(ledger.stopReason, "[REDACTED]");
    assert.equal(ledger.events[0].flowerName, "白百合");
    assert.equal(ledger.events[0].status, "success");
  });
});
