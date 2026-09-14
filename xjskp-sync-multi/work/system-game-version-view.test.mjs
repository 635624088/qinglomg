import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const viewModule = await import("./system/public/game-version-view.js").catch(() => ({}));
const {
  buildGameVersionView,
  formatGameDataSyncFailure,
  formatGameDataSyncSuccess,
  hasBlockingGameDataRuntime,
} = viewModule;

test("Task4 builds independent code and data pills", () => {
  assert.equal(typeof buildGameVersionView, "function");
  const view = buildGameVersionView({
    version: {
      lastSuccessfulCheckAt: "2026-08-12T03:00:00.000Z",
      code: {
        localVersion: "391.0.25",
        officialVersion: "400.0.15",
        comparison: "newer",
        analyzedVersion: "380.0.25",
        reviewStatus: "pending-analysis",
      },
      data: {
        activeVersion: "2f3f6",
        activeSourceCodeVersion: "391.0.25",
        compatibilityStatus: "unknown",
        syncStatus: "idle",
      },
    },
    profile: { id: "main", hasCredentials: true },
    runtime: {},
  });

  assert.deepEqual(view.code, {
    state: "newer",
    localVersion: "391.0.25",
    officialVersion: "400.0.15",
    statusText: "待分析",
    title: "发现官方新版本，需单独分析代码逻辑；最近成功检查：2026/08/12 11:00:00；已分析版本：380.0.25",
  });
  assert.deepEqual(view.data, {
    state: "current",
    activeVersion: "2f3f6",
    sourceCodeVersion: "391.0.25",
    statusText: "当前启用",
    title: "当前启用数据 2f3f6；来源代码 391.0.25；兼容结论：未知；最近成功同步：-",
  });
});

test("Task4 restores active sync phases and disables both official operations", () => {
  for (const [syncStatus, expectedStatus] of [
    ["downloading", "下载中"],
    ["validating", "校验中"],
    ["activating", "激活中"],
  ]) {
    const view = buildGameVersionView({
      version: {
        checking: false,
        code: { localVersion: "391.0.25", officialVersion: "400.0.15", comparison: "newer", reviewStatus: "pending-analysis" },
        data: { activeVersion: "2f3f6", activeSourceCodeVersion: "391.0.25", candidateVersion: "abc12", candidateSourceCodeVersion: "400.0.15", compatibilityStatus: "checking", syncStatus, phase: syncStatus },
      },
      profile: { id: "main", hasCredentials: true },
      runtime: {},
    });
    assert.equal(view.data.statusText, expectedStatus);
    assert.equal(view.syncButton.disabled, true);
    assert.match(view.syncButton.text, /^同步中…/);
    assert.equal(view.checkButton.disabled, true);
  }
});

test("Task4 maps code review states and warns without blocking newer-source data", () => {
  const current = buildGameVersionView({
    version: { code: { localVersion: "400.0.15", officialVersion: "400.0.15", comparison: "same", reviewStatus: "current" }, data: {} },
    profile: { id: "main", hasCredentials: true },
    runtime: {},
  });
  assert.equal(current.code.statusText, "已是最新");

  const pending = buildGameVersionView({
    version: {
      code: { localVersion: "391.0.25", officialVersion: "400.0.15", comparison: "newer", reviewStatus: "pending-analysis" },
      data: { activeVersion: "abc12", activeSourceCodeVersion: "400.0.15", syncStatus: "latest", compatibilityStatus: "compatible" },
    },
    profile: { id: "main", hasCredentials: true },
    runtime: {},
  });
  assert.equal(pending.code.statusText, "待分析");
  assert.match(pending.data.title, /来源代码高于本地代码/);
  assert.equal(pending.syncButton.disabled, false);

  const analyzed = buildGameVersionView({
    version: { code: { localVersion: "391.0.25", officialVersion: "400.0.15", comparison: "newer", reviewStatus: "current" }, data: {} },
    profile: { id: "main", hasCredentials: true },
    runtime: {},
  });
  assert.equal(analyzed.code.statusText, "已分析");
});

test("Task4 blocks sync without a ready profile or while any runtime is active or transitional", () => {
  const base = {
    version: { code: {}, data: { activeVersion: "2f3f6", syncStatus: "idle" } },
    runtime: {},
  };
  assert.equal(buildGameVersionView(base).syncButton.title, "请先选择账号");
  assert.equal(buildGameVersionView({ ...base, profile: { id: "main", hasCredentials: false } }).syncButton.title, "当前账号凭据不完整");
  assert.equal(buildGameVersionView({
    ...base,
    profile: { id: "main", hasCredentials: false, missingFields: ["BABI_TOKEN", "OPEN_ID"] },
  }).syncButton.disabled, false);
  assert.equal(buildGameVersionView({
    ...base,
    profile: { id: "main", hasCredentials: true, missingFields: ["PC_TOKEN"] },
  }).syncButton.title, "当前账号缺少 CTOKEN、PC_USER_ID 或 PC_TOKEN");
  assert.equal(buildGameVersionView({
    ...base,
    profile: { id: "main", hasCredentials: true },
    pendingAction: { action: "start", profileId: "main" },
  }).syncButton.disabled, true);
  assert.equal(buildGameVersionView({
    ...base,
    profile: { id: "main", hasCredentials: true },
    runtime: { runningCount: 1 },
  }).syncButton.text, "请先停止全部任务再同步");

  const runtimes = [
    { runningCount: 1 },
    { activeTasks: [{ profileId: "main" }] },
    { legacyProcesses: [{ pid: 12 }] },
    { desiredRuns: [{ desiredState: "running" }] },
    { desiredRuns: [{ desiredState: "unresolved" }] },
    { recoveryByProfile: { main: { recoveryPending: true } } },
    { recoveryByProfile: { main: { recoveryStatus: "starting" } } },
  ];
  for (const runtime of runtimes) {
    assert.equal(hasBlockingGameDataRuntime(runtime), true);
    const view = buildGameVersionView({ ...base, profile: { id: "main", hasCredentials: true }, runtime });
    assert.equal(view.syncButton.disabled, true);
    assert.equal(view.syncButton.title, "请先停止全部账号任务，并等待启动、停止或恢复状态收敛");
  }
});

test("Task4 DOM keeps two version pills and the sync button immediately after version check", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("work/system/public/index.html", "utf8"),
    readFile("work/system/public/app.js", "utf8"),
    readFile("work/system/public/styles.css", "utf8"),
  ]);
  const codeIndex = html.indexOf('id="gameVersionMeta"');
  const dataIndex = html.indexOf('id="gameDataVersionMeta"');
  const checkIndex = html.indexOf('id="checkGameVersionButton"');
  const syncIndex = html.indexOf('id="syncGameDataButton"');
  assert.ok(codeIndex >= 0 && codeIndex < dataIndex);
  assert.ok(checkIndex >= 0 && checkIndex < syncIndex);
  assert.match(html, /代码\s*<strong id="localGameVersion">/);
  assert.match(html, /官方\s*<strong id="remoteGameVersion">/);
  assert.match(html, /数据\s*<strong id="activeGameDataVersion">/);
  assert.match(html, /id="gameDataSyncFeedback"/);
  assert.match(app, /from "\.\/game-version-view\.js"/);
  assert.match(app, /api\("\/api\/system\/game-data\/sync"/);
  assert.match(app, /const syncGeneration = \+\+gameVersionStateGeneration/);
  assert.match(app, /pollGameDataSyncStatus\(polling, syncGeneration\)/);
  assert.match(app, /generation !== gameVersionStateGeneration/);
  assert.match(app, /data:\s*result\.data/);
  assert.match(app, /POST 已确认成功时保留响应内的数据状态/);
  assert.match(styles, /\.game-data-sync-feedback/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)/);
});

test("Task4 makes manual-review, incompatible and failed results explicit while retaining active data", () => {
  for (const [compatibilityStatus, statusText] of [
    ["manual-review", "需人工复核"],
    ["incompatible", "不兼容"],
  ]) {
    const view = buildGameVersionView({
      version: { data: { activeVersion: "2f3f6", candidateVersion: "abc12", candidateSourceCodeVersion: "400.0.15", compatibilityStatus, syncStatus: "blocked", reportPath: "runtime/game-data/versions/abc12/compatibility-report.json" } },
      profile: { id: "main", hasCredentials: true },
      runtime: {},
    });
    assert.equal(view.data.statusText, statusText);
    assert.match(view.feedback.text, /未启用候选代码和数据，当前数据仍使用 2f3f6/);
    assert.match(view.feedback.text, /runtime\/game-data\/versions\/abc12\/compatibility-report\.json/);
  }

  const failed = buildGameVersionView({
    version: { data: { activeVersion: "2f3f6", syncStatus: "failed", phase: "download", lastError: { message: "候选游戏数据下载失败" } } },
    profile: { id: "main", hasCredentials: true },
    runtime: {},
  });
  assert.equal(failed.data.statusText, "同步失败");
  assert.match(failed.feedback.text, /失败阶段：下载/);
  assert.match(failed.feedback.text, /当前数据仍使用 2f3f6/);
});

test("Task4 success and failure summaries keep code changes out of data sync", () => {
  assert.equal(
    formatGameDataSyncSuccess({
      data: {
        previousVersion: "2f3f6",
        activeVersion: "abc12",
        activeSourceCodeVersion: "400.0.15",
        compatibilityStatus: "compatible",
        loaderCount: 17,
      },
      codeUnchanged: true,
    }),
    "游戏代码已从 - 更新为 400.0.15，游戏数据已从 2f3f6 同步为 abc12；自动任务代码兼容分析通过，17 个加载器通过，数据兼容结论：兼容。",
  );

  assert.equal(
    formatGameDataSyncFailure({
      message: "候选数据与当前代码不兼容，未启用",
      data: { phase: "validation", activeDataVersion: "2f3f6", reportPath: "runtime/report.json" },
    }),
    "失败阶段：兼容校验；候选数据与当前代码不兼容，未启用。未启用候选代码和数据，当前数据仍使用 2f3f6；诊断报告：runtime/report.json。",
  );
});
