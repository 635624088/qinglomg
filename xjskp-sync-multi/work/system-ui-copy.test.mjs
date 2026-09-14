import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

const publicDir = path.join(import.meta.dirname, "system", "public");
const mojibakePattern = /椴滆姳|璐﹀彿|鐘舶|鑷姩|閼奉|閸殀/;

test("console html uses readable Chinese wizard-first account copy", async () => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf8");

  assert.match(html, /鲜花小镇自动化控制台/);
  assert.match(html, /账号启动向导/);
  assert.match(html, /一键迁移旧账号/);
  assert.match(html, /粘贴 cURL \/ HAR \/ 请求头/);
  assert.match(html, /只查订单/);
  assert.match(html, /双倍金币剩余/);
  assert.match(html, /ACCOUNTS/);
  assert.match(html, /IMPORT ACCOUNT/);
  assert.doesNotMatch(html, mojibakePattern);
});

test("console places the official version control in the requested toolbar and topbar positions", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);
  const lockIndex = html.indexOf('id="lockState"');
  const versionIndex = html.indexOf('id="gameVersionMeta"');
  const dataVersionIndex = html.indexOf('id="gameDataVersionMeta"');
  const refreshIndex = html.indexOf('id="refreshButton"');
  const ordersIndex = html.indexOf('id="ordersButton"');
  const checkIndex = html.indexOf('id="checkGameVersionButton"');
  const syncIndex = html.indexOf('id="syncGameDataButton"');

  assert.ok(lockIndex >= 0 && lockIndex < versionIndex && versionIndex < dataVersionIndex && dataVersionIndex < refreshIndex);
  assert.ok(ordersIndex >= 0 && ordersIndex < checkIndex && checkIndex < syncIndex);
  assert.match(html, /代码\s*<strong id="localGameVersion">-<\/strong>/);
  assert.match(html, /官方\s*<strong id="remoteGameVersion">-<\/strong>/);
  assert.match(html, /数据\s*<strong id="activeGameDataVersion">-<\/strong>/);
  assert.match(html, />检查游戏官方版本<\/button>/);
  assert.match(html, />同步最新版游戏代码和数据<\/button>/);
  assert.match(script, /api\("\/api\/system\/game-version"\)/);
  assert.match(script, /api\("\/api\/system\/game-version\/check"/);
  assert.match(script, /api\("\/api\/system\/game-data\/sync"/);
  assert.match(script, /function renderGameVersion\(\)/);
  assert.match(script, /from "\.\/game-version-view\.js"/);
  assert.match(styles, /\.game-version-meta/);
  assert.match(styles, /\.game-version-meta\[data-state="newer"\]/);
  assert.doesNotMatch(html, /id="gameVersionPanel"/);
});

test("console removes redundant visible English section labels and task hint row", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.doesNotMatch(html, /XJSKP LOCAL CONSOLE/);
  assert.doesNotMatch(html, /ACCOUNT WIZARD/);
  assert.doesNotMatch(html, /TASK CONTROL/);
  assert.doesNotMatch(html, /LIVE SUMMARY/);
  assert.doesNotMatch(html, /AUTOMATION MATRIX/);
  assert.doesNotMatch(html, /id="systemState"/);
  assert.doesNotMatch(html, /class="run-params"/);
  assert.doesNotMatch(script, /\$\("systemState"\)/);
  assert.doesNotMatch(script, /\$\("safeHint"\)/);
  assert.doesNotMatch(styles, /\.run-params/);
  assert.match(styles, /\.shell\s*{[^}]*padding:\s*16px\s+0\s+22px/s);
  assert.match(styles, /\.topbar\s*{[^}]*margin-bottom:\s*10px/s);
  assert.match(styles, /\.task-panel\s*{[^}]*gap:\s*10px/s);
});

test("console script exposes legacy migration and validation workflow copy", async () => {
  const script = await readFile(path.join(publicDir, "app.js"), "utf8");

  assert.match(script, /api\/migration\/legacy-credentials/);
  assert.match(script, /迁移完成/);
  assert.match(script, /验证账号/);
  assert.match(script, /凭据完整/);
  assert.doesNotMatch(script, mojibakePattern);
});

test("console styles prevent cramped profile cards and support a wizard layout", async () => {
  const styles = await readFile(path.join(publicDir, "styles.css"), "utf8");

  assert.match(styles, /\.wizard-panel/);
  assert.match(styles, /\.profile-card/);
  assert.match(styles, /overflow-wrap:\s*anywhere/);
  assert.match(styles, /grid-template-columns:\s*minmax\(280px,\s*clamp\(300px,\s*22vw,\s*360px\)\)\s+minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.profile-run-badge\s*{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.profile-run-badge\s+span\s*{[^}]*text-overflow:\s*ellipsis/s);
});

test("console styles keep the live summary compact without fixed-width overflow", async () => {
  const styles = await readFile(path.join(publicDir, "styles.css"), "utf8");

  assert.match(styles, /\.summary-panel\s*{[^}]*align-self:\s*start/s);
  assert.match(styles, /\.summary-columns\s*{[^}]*gap:\s*8px/s);
  assert.match(styles, /\.summary-section\s*{[^}]*grid-template-columns:\s*64px\s+minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.summary-section\.resource-section/s);
  assert.match(styles, /\.summary-panel\s+\.metric-grid\s*{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(86px,\s*1fr\)\)/s);
  assert.match(styles, /\.resource-grid,\s*[\r\n]+\.risk-grid\s*{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(118px,\s*1fr\)\)/s);
  assert.match(styles, /\.land-section\s+\.countdown\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(styles, /\.land-section\s+\.countdown\s*{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(styles, /\.metric\s*{[^}]*min-height:\s*32px/s);
  assert.match(styles, /\.summary-panel\s+\.metric\s*{[^}]*display:\s*flex/s);
  assert.match(styles, /\.summary-panel\s+\.metric\s+strong\s*{[^}]*overflow-wrap:\s*anywhere/s);
});

test("console styles keep the account panel compact for multiple profiles", async () => {
  const [script, collections, styles] = await Promise.all([
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "keyed-collections-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /formatCompactDateTime/);
  assert.match(script, /missingCount:\s*String\(missingCount\)/);
  assert.match(collections, /createTextLeaf\(document,\s*"span",\s*"",\s*"missing-count"\)/);
  assert.match(styles, /grid-template-columns:\s*minmax\(280px,\s*clamp\(300px,\s*22vw,\s*360px\)\)\s+minmax\(0,\s*1fr\)/);
  assert.match(styles, /\.account-panel\s*{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.account-panel\s*{[^}]*grid-template-rows:\s*auto\s+auto\s+auto\s+minmax\(0,\s*1fr\)\s+auto/s);
  assert.match(styles, /\.profile-list\s*{[^}]*max-height:\s*none/s);
  assert.match(styles, /\.profile-list\s*{[^}]*min-height:\s*0/s);
  assert.match(styles, /\.profile-list\s*{[^}]*align-content:\s*start/s);
  assert.match(styles, /\.profile-list\s*{[^}]*grid-auto-rows:\s*max-content/s);
  assert.match(styles, /\.profile-list\s*{[^}]*overflow-y:\s*auto/s);
  assert.match(styles, /\.profile-card\s*{[^}]*min-height:\s*58px/s);
  assert.match(styles, /\.profile-card\s*{[^}]*align-self:\s*start/s);
  assert.match(styles, /\.wizard-panel\s*{[^}]*padding:\s*10px\s+12px/s);
  assert.match(styles, /\.task-panel\s+\.profile-chip\s*{[^}]*text-overflow:\s*ellipsis/s);
});

test("console lays out account sidebar, right workspace, and removes inline detail tabs", async () => {
  const [html, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  const accountPanelStart = html.indexOf('<aside class="panel account-panel">');
  const rightWorkspaceStart = html.indexOf('<section class="right-workspace">');
  const topWorkspaceStart = html.indexOf('<section class="top-workspace">');
  const taskPanelStart = html.indexOf('<section class="panel task-panel">');
  const taskPanelEnd = html.indexOf("</section>", taskPanelStart);
  const summaryPanelStart = html.indexOf('<aside class="panel summary-panel">');
  const accountLevelSummary = html.indexOf('<div id="accountLevelSummary"', taskPanelStart);
  const artifactLinks = html.indexOf('<div id="artifactLinks"', taskPanelStart);
  const monitorPanelStart = html.indexOf('<section class="monitor-panel">');

  assert.ok(accountPanelStart >= 0, "account panel is present");
  assert.ok(rightWorkspaceStart > accountPanelStart, "right workspace is beside account panel");
  assert.ok(topWorkspaceStart > rightWorkspaceStart, "top workspace is inside right workspace");
  assert.ok(taskPanelStart >= 0, "task panel is present");
  assert.ok(summaryPanelStart > taskPanelStart, "summary panel is in the right-side top row");
  assert.ok(accountLevelSummary > taskPanelStart, "account level summary is inside task panel");
  assert.ok(artifactLinks > accountLevelSummary, "artifact links are below account level summary");
  assert.ok(artifactLinks < taskPanelEnd, "artifact links are inside task panel");
  assert.ok(monitorPanelStart > summaryPanelStart, "monitor panel is below top workspace");
  assert.doesNotMatch(html, /id="detailTabs"/);
  assert.doesNotMatch(html, /id="tabContent"/);
  assert.match(styles, /\.right-workspace\s*{[^}]*grid-template-rows:\s*auto\s+minmax\(360px,\s*auto\)/s);
  assert.doesNotMatch(styles, /\.right-workspace\s*{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.top-workspace\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.12fr\)\s+minmax\(320px,\s*0\.88fr\)/s);
  assert.match(styles, /\.monitor-panel\s*{[^}]*margin-top:\s*0/s);
  assert.match(styles, /\.queue-matrix\s*{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /\.task-artifact-links/);
  assert.match(styles, /\.task-artifact-links\s+a\s*{[^}]*min-height:\s*30px/s);
});

test("console monitor uses common, secondary, cyclic-story, cyclic-note, and team-order tabs", async () => {
  const [html, script, queueView, cyclicView, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "cyclic-story-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(html, /id="queueTabs"/);
  assert.match(html, /data-queue-tab="common"[^>]*aria-selected="true"[^>]*>常用/);
  assert.match(html, /data-queue-tab="secondary"[^>]*>不常用/);
  assert.match(html, /data-queue-tab="activities"[^>]*>莳花纪闻/);
  assert.match(html, /data-queue-tab="cyclic-note"[^>]*>花笺集芳/);
  assert.match(html, /data-queue-tab="team-orders"[^>]*>组团订单/);
  assert.match(html, /id="teamOrderPanel"[^>]*class="team-order-console"[^>]*hidden/);
  assert.ok(
    html.indexOf('id="teamOrderPanel"') > html.indexOf('<section class="monitor-panel">'),
    "team-order panel must live inside automation monitor",
  );
  assert.equal((html.match(/class="team-order-console"/g) || []).length, 1);
  assert.match(script, /queueTab:\s*"common"/);
  assert.match(script, /QUEUE_TAB_KEYS\s*=\s*new Set\(\["common",\s*"secondary",\s*"activities",\s*"cyclic-note",\s*"team-orders"\]\)/);
  assert.match(script, /queueDashboard\.render\(view/);
  assert.match(queueView, /setBooleanPropertyIfChanged\(shell\.queueMatrix, "hidden", activeTab === "team-orders"\)/);
  assert.match(queueView, /setBooleanPropertyIfChanged\(shell\.teamOrderPanel, "hidden", activeTab !== "team-orders"\)/);
  assert.match(script, /QUEUE_MODULE_GROUPS\s*=\s*{[\s\S]*common:\s*\[[\s\S]*水车水滴[\s\S]*挑水工水滴[\s\S]*普通居民订单[\s\S]*丝绸建材[\s\S]*经验保护[\s\S]*土地补种[\s\S]*主线任务[\s\S]*顾客订单/s);
  assert.match(script, /secondary:\s*\[[\s\S]*宫廷订单[\s\S]*公会土地[\s\S]*花架金币[\s\S]*珍珠采集[\s\S]*材料商城/s);
  assert.doesNotMatch(script, /secondary:\s*\[[^\]]*顾客订单/);
  assert.match(script, /activities:\s*\[[\s\S]*area:\s*"莳花纪闻"[\s\S]*\]/s);
  assert.match(script, /function buildQueueDashboardView\(/);
  assert.match(script, /cyclicStory:\s*buildCyclicStoryView\(/);
  assert.match(queueView, /function patchTabs\(/);
  assert.match(queueView, /`queue-matrix queue-matrix-\$\{activeTab\}`/);
  assert.match(queueView, /createCyclicStoryRenderer\(/);
  assert.match(cyclicView, /const SLOT_COUNT = 3/);
  assert.match(styles, /\.queue-tabs\s*{/);
  assert.match(styles, /\.queue-card\.cyclic-story-queue-card\s*{[^}]*border:\s*0[^}]*padding:\s*0[^}]*background:\s*transparent/s);
  assert.match(styles, /\.queue-tabs\s+button\.active/);
  assert.match(styles, /\.team-order-console\[hidden\]\s*{\s*display:\s*none/);
  assert.match(html, /仅显示最近 7 天的完成记录，硬盘归档与日志保持不变/);
  assert.doesNotMatch(html, /id="teamOrderCurrent"|id="teamOrderRecent"/);
  assert.doesNotMatch(html, /id="teamOrderPrevButton"|id="teamOrderNextButton"/);
  assert.match(styles, /\.team-order-day-group\s*{[^}]*grid-template-columns:\s*92px\s+minmax\(0,\s*1fr\)/s);
  assert.match(styles, /\.team-order-day-grid\s*{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /\.team-order-archive-item\s*{[^}]*gap:\s*6px;[^}]*padding:\s*7px\s+8px/s);
  assert.match(
    styles,
    /@media\s*\(min-width:\s*1920px\)[\s\S]*?\.team-order-card-metrics\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*0\.8fr\)\)\s+repeat\(2,\s*minmax\(0,\s*1\.3fr\)\)/s,
  );
  assert.match(
    styles,
    /@media\s*\(min-width:\s*1920px\)[\s\S]*?\.team-order-card-metric-row\s*{[^}]*display:\s*contents/s,
  );
  assert.match(styles, /\.queue-matrix\s+\.queue-card\s*{[\s\S]*grid-column:\s*span\s+3/s);
  assert.match(styles, /#queueMatrix\.queue-matrix-activities\s+\.queue-card\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  assert.match(styles, /\.cyclic-story-order-grid\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.doesNotMatch(styles, /\.queue-matrix-common\s+\.queue-layout-common-4[\s\S]*grid-column:\s*span\s+6/s);
  assert.doesNotMatch(styles, /\.queue-matrix-secondary\s+\.queue-layout-secondary-5[\s\S]*grid-column:\s*span\s+(?:6|8)/s);
});

test("flower rack target selector reserves enough width for complete option text", async () => {
  const [queueView, styles] = await Promise.all([
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(queueView, /\["queue-switch", "flower-rack-target-switch"\]/);
  assert.match(
    styles,
    /\.flower-rack-target-switch\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+minmax\(280px,\s*2fr\)/s,
  );
  assert.match(styles, /\.flower-rack-target-switch\s+select\s*{[^}]*width:\s*100%/s);
  assert.match(styles, /\.flower-rack-target-switch\s+b\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s);
});

test("console monitor uses queue data without inline detail tab rendering code", async () => {
  const [script, queueView, queueCollections, archiveView] = await Promise.all([
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "queue-collections-view.js"), "utf8"),
    readFile(path.join(publicDir, "team-order-archive-view.js"), "utf8"),
  ]);

  assert.doesNotMatch(script, /renderTabs/);
  assert.doesNotMatch(script, /detailTabs/);
  assert.match(script, /function renderQueue\(/);
  assert.match(script, /state\.status\?\.queue/);
  assert.doesNotMatch(script, /\$\("queueMatrix"\)\.innerHTML/);
  assert.doesNotMatch(queueView, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.doesNotMatch(queueCollections, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.doesNotMatch(archiveView, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.match(script, /queueCollections\.renderOrdinary\(/);
  assert.match(script, /queueCollections\.renderCyclicNote\(/);
  assert.match(script, /teamOrderArchive\.render\(/);
  assert.match(script, /doubleGoldRemainingText/);
  assert.doesNotMatch(script, /nextRunText"\)\.textContent = state\.status\?\.land\?\.nextMatureText/);
  assert.match(script, /row\?\.rule/);
  assert.match(queueView, /queue-empty/);
});

test("console monitor maps queue aliases and shows waterwheel and satin material data", async () => {
  const [script, queueView, specialOrderView, styles] = await Promise.all([
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "special-order-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(script, /aliases:\s*\[\s*"水车水桶"\s*\]/);
  assert.match(script, /aliases:\s*\[\s*"丝绸\/建材"\s*\]/);
  assert.match(script, /waterDropText/);
  assert.match(script, /waterDropNextRestoreText/);
  assert.match(script, /waterwheelRemainingBucketCount/);
  assert.match(script, /waterwheelMaxBucketCount/);
  assert.match(script, /waterwheelStoredBucketCount/);
  assert.match(script, /waterwheelStoredBucketMax/);
  assert.match(script, /waterwheelRemainingDailyBucketCount/);
  assert.match(script, /waterwheelNextBucketNo/);
  assert.match(script, /satinSilkText/);
  assert.match(script, /buildingMaterialText/);
  assert.match(script, /specialOrders\?\.satin/);
  assert.match(script, /specialOrders\?\.decorate/);
  assert.match(script, /completedCount/);
  assert.match(script, /dailyLimit/);
  assert.match(script, /getOrderCompletionParts/);
  assert.match(specialOrderView, /remainingText/);
  assert.match(specialOrderView, /function formatStatus\(order, state\)/);
  assert.match(
    specialOrderView,
    /state === "cooldown" && remaining && remaining !== "-"[\s\S]*return `\$\{base\}（\$\{remaining\}）`/,
  );
  assert.match(queueView, /丝绸完成/);
  assert.match(queueView, /建材完成/);
  assert.match(queueView, /丝绸状态/);
  assert.match(queueView, /建材状态/);
  assert.match(queueView, /queue-stats/);
  assert.match(queueView, /queue-stat/);
  assert.match(styles, /\.queue-stats\s*{/);
  assert.match(styles, /\.queue-stat\s*{/);
  assert.match(styles, /@media\s*\(min-width:\s*1241px\)/);
  assert.doesNotMatch(styles, /html,\s*body\s*{[^}]*overflow:\s*hidden/s);
  assert.match(styles, /\.shell\s*{[^}]*height:\s*100vh/s);
  assert.match(styles, /\.queue-matrix\s*{[^}]*overflow-y:\s*auto/s);
});

test("satin material metrics use a scoped six-column 2/3/3 layout", async () => {
  const [queueView, styles] = await Promise.all([
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(queueView, /function createSatinMaterialCard\(/);
  assert.match(queueView, /metrics\.root\.classList\.add\("satin-material-metrics"\)/);
  assert.match(
    styles,
    /\.satin-material-metrics\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(
    styles,
    /\.satin-material-metrics\s*>\s*\.queue-stat:nth-child\(-n\+2\)\s*\{[^}]*grid-column:\s*span\s+3/s,
  );
  assert.match(
    styles,
    /\.satin-material-metrics\s*>\s*\.queue-stat:nth-child\(n\+3\)\s*\{[^}]*grid-column:\s*span\s+2/s,
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.queue-stats\.satin-material-metrics\s*\{[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.doesNotMatch(
    styles,
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.satin-material-metrics\s*\{[^}]*grid-template-columns:\s*1fr/s,
  );
  assert.match(styles, /\.queue-stats\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(112px,\s*1fr\)\)/s);
  assert.doesNotMatch(styles, /\.queue-stats\s*>\s*\.queue-stat:nth-child/);
});

test("console styles include responsive overflow guardrails across desktop and mobile", async () => {
  const styles = await readFile(path.join(publicDir, "styles.css"), "utf8");

  assert.match(styles, /body\s*{[^}]*overflow-x:\s*hidden/s);
  assert.match(styles, /\.topbar-actions\s*>\s*\*\s*{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.task-grid\s*{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(150px,\s*100%\),\s*1fr\)\)/s);
  assert.match(styles, /\.queue-card\s*>\s*\*\s*{[^}]*min-width:\s*0/s);
  assert.match(styles, /\.queue-switch\s+span\s*{[^}]*white-space:\s*normal/s);
  assert.match(styles, /\.queue-stat\s+strong\s*{[^}]*overflow-wrap:\s*anywhere/s);
  assert.match(
    styles,
    /\.cyclic-story-order-metrics\s*{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(82px,\s*100%\),\s*1fr\)\)/s,
  );
  assert.match(
    styles,
    /\.cyclic-story-flower\s*>\s*small\s*{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/s,
  );
  assert.match(styles, /@media\s*\(max-width:\s*1500px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(styles, /@media\s*\(max-width:\s*720px\)/);
  assert.match(
    styles,
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.game-version-meta\s*{[^}]*flex:\s*1 1 100%[^}]*white-space:\s*normal/s,
  );
});

test("customer order reward controls stay in a compact scoped row and keep the existing mapping", async () => {
  const [app, queueView, styles] = await Promise.all([
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(queueView, /\["customer-order-reward-switches"\]/);
  assert.match(queueView, /metrics\.root\.classList\.add\("customer-order-daily-metrics"\)/);
  assert.match(
    styles,
    /\.customer-order-daily-metrics\s*>\s*\.queue-stat\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto[^}]*align-items:\s*center/s,
  );
  assert.match(
    styles,
    /\.customer-order-daily-metrics\s*>\s*\.queue-stat\s*>\s*strong\s*\{[^}]*justify-self:\s*end[^}]*text-align:\s*right[^}]*white-space:\s*nowrap/s,
  );
  assert.match(
    styles,
    /\.customer-order-reward-switches\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0,\s*1\.35fr\)\s+repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*gap:\s*4px/s,
  );
  assert.match(
    styles,
    /\.customer-order-reward-switches\s*>\s*\.queue-switch\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*nowrap[^}]*gap:\s*3px[^}]*padding:\s*3px\s+4px/s,
  );
  assert.match(
    styles,
    /\.customer-order-reward-switches\s*>\s*\.queue-switch\s+input\[type="checkbox"\]\s*\{[^}]*width:\s*13px[^}]*height:\s*13px/s,
  );
  assert.match(
    styles,
    /\.customer-order-reward-switches\s*>\s*\.queue-switch\s+span\s*\{[^}]*font-size:\s*11px[^}]*white-space:\s*normal/s,
  );
  assert.match(
    styles,
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.customer-order-reward-switches\s*>\s*\.queue-switch\s+input\[type="checkbox"\]\s*\{[^}]*width:\s*12px[^}]*height:\s*12px/s,
  );
  assert.match(styles, /\.queue-switch\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(app, /const customerRewardMatch = \/\^customerOrderReward\(\[123\]\)Toggle\$\//);
  assert.match(app, /const bit = 1 << \(reward - 1\);[\s\S]*customerOrderFlowerCurrencyRewardReleaseMask: nextMask/);
});

test("console styles expand high-resolution layouts and avoid desktop monitor clipping", async () => {
  const styles = await readFile(path.join(publicDir, "styles.css"), "utf8");

  assert.match(styles, /\.shell\s*{[^}]*width:\s*min\(1840px,\s*calc\(100vw - 32px\)\)/s);

  const highResStart = styles.indexOf("@media (min-width: 1920px)");
  assert.ok(highResStart > 0, "expected a 1920px+ high-resolution layout media query");
  const highResEnd = styles.indexOf("@media (min-width: 2100px)", highResStart);
  assert.ok(highResEnd > highResStart, "expected a 2100px+ ultrawide layout after the 1920px+ rules");
  const highResRules = styles.slice(highResStart, highResEnd);

  assert.match(highResRules, /\.shell\s*{[^}]*width:\s*min\(1880px,\s*calc\(100vw - 48px\)\)/s);
  assert.match(highResRules, /\.dashboard-grid\s*{[^}]*grid-template-columns:\s*minmax\(320px,\s*clamp\(340px,\s*19vw,\s*420px\)\)\s+minmax\(0,\s*1fr\)/s);
  assert.match(highResRules, /\.monitor-panel\s*{[^}]*max-height:\s*none[^}]*overflow:\s*visible/s);
  assert.match(highResRules, /\.queue-matrix\s*{[^}]*overflow-y:\s*visible[^}]*padding-right:\s*0/s);
  assert.match(highResRules, /\.queue-card\s+em\s*{[^}]*-webkit-line-clamp:\s*4/s);

  const ultrawideRules = styles.slice(highResEnd);
  assert.match(ultrawideRules, /\.shell\s*{[^}]*width:\s*min\(2240px,\s*calc\(100vw - 64px\)\)/s);
  assert.match(ultrawideRules, /\.queue-matrix\s*{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s);
  assert.doesNotMatch(ultrawideRules, /\.queue-matrix-common\s+\.queue-layout-common-4[\s\S]*grid-column:\s*span\s+8/s);
  assert.doesNotMatch(ultrawideRules, /\.queue-matrix-secondary\s+\.queue-layout-secondary-5[\s\S]*grid-column:\s*span\s+8/s);
});

test("console monitor renders six compact ordinary resident order slots", async () => {
  const [script, queueView, queueCollections, styles] = await Promise.all([
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "queue-collections-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);
  const ordinarySlots = queueCollections;

  assert.match(queueView, /function createOrdinaryCard\(/);
  assert.match(queueView, /function patchOrdinaryCard\(/);
  assert.match(script, /ordinaryResidentOrders/);
  assert.match(queueView, /自动提交普通居民订单/);
  assert.doesNotMatch(queueView, /等级提升自动提交普通居民订单/);
  assert.match(script, /readyCount/);
  assert.match(script, /pendingAutoSubmitActions/);
  assert.match(script, /updateProfileSettings/);
  assert.match(script, /api\/profiles\/\$\{encodeURIComponent\(effect\.profileId\)\}\/settings/);
  assert.match(script, /autoSubmitOrdinaryResidentOrdersForLevelUp/);
  assert.match(script, /pearlHireItemReserveCount/);
  assert.match(script, /pearlHireItemReserveInput/);
  assert.match(script, /teamOrderTriggerProtectionEnabled/);
  assert.match(script, /teamOrderProtectionToggle/);
  assert.match(script, /49\/99 组团触发放行/);
  assert.match(queueView, /珍珠雇佣卡保留量/);
  assert.match(script, /levelUpAutoSubmitEnabled/);
  assert.match(script, /ordinaryAutoSubmitToggle/);
  assert.match(script, /mainTaskStatusAfter/);
  assert.match(script, /ordinaryResidentOrderGateReason/);
  assert.match(script, /formatOrdinaryResidentGateReason/);
  assert.match(script, /const ORDINARY_RESIDENT_ORDER_SLOT_COUNT = 6/);
  assert.match(ordinarySlots, /const ORDINARY_SLOT_COUNT = 6/);
  assert.match(ordinarySlots, /length:\s*ORDINARY_SLOT_COUNT/);
  assert.match(script, /order\.isVideo/);
  assert.match(ordinarySlots, /视频订单/);
  assert.match(script, /order\.refillPending/);
  assert.match(ordinarySlots, /等待补位/);
  assert.match(ordinarySlots, /等待服务端补位/);
  assert.match(ordinarySlots, /requirement\?\.name/);
  assert.match(ordinarySlots, /createTextLeaf\(document, "span", "\*"\)/);
  assert.match(script, /function buildOrdinaryResidentQueueView\(/);
  assert.match(script, /autoSubmitOrdinaryResidentOrdersForLevelUp/);
  assert.match(script, /levelUpAutoSubmitEnabled/);
  assert.match(script, /ordinaryAutoSubmitEnabled/);
  assert.match(queueView, /今日完成/);
  assert.match(queueView, /可完成/);
  assert.match(queueView, /放行原因/);
  assert.match(script, /自动提交普通居民订单开关关闭/);
  assert.match(script, /queueCollections\.renderOrdinary\(/);
  assert.doesNotMatch(queueView, /renderOrdinaryResidentOrderSlots/);
  assert.doesNotMatch(queueView, /requirements/);
  assert.doesNotMatch(queueCollections, /innerHTML|outerHTML|replaceChildren|insertAdjacentHTML/);
  assert.match(styles, /\.queue-switch/);
  assert.match(styles, /\.queue-card\.blocked/);
  assert.match(styles, /\.ordinary-resident-order-slots\s*{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(styles, /\.ordinary-resident-order-slot/);
});

test("console task panel shows account level and experience above artifact links", async () => {
  const [html, script, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(html, /id="accountLevelSummary"/);
  assert.match(script, /renderAccountLevelSummary/);
  assert.match(script, /accountLevel/);
  assert.match(script, /progressText/);
  assert.match(styles, /\.account-level-summary/);
  assert.ok(html.indexOf("accountLevelSummary") < html.indexOf("artifactLinks"));
});

test("console moves the editable experience guard fields into the automation card without duplication", async () => {
  const [html, script, queueView, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);
  const accountSummary = script.slice(
    script.indexOf("function renderAccountLevelSummary"),
    script.indexOf("function renderArtifactLinks"),
  );
  const experienceGuardCard = queueView.slice(
    queueView.indexOf("function createExperienceGuardCard"),
    queueView.indexOf("function patchExperienceGuardCard"),
  );
  const riskSummary = script.slice(
    script.indexOf("function renderSummary"),
    script.indexOf("function renderQueue"),
  );
  const percentIndex = experienceGuardCard.indexOf("经验保护百分比");
  const statusIndex = experienceGuardCard.indexOf("经验保护状态");
  const lineIndex = experienceGuardCard.indexOf("经验保护线");
  const distanceIndex = experienceGuardCard.indexOf("距离经验保护线");

  assert.doesNotMatch(accountSummary, /经验保护百分比|经验保护状态|经验保护线|experienceGuardThresholdInput/);
  assert.match(html, /accountServerSummaryValue[\s\S]*accountLevelValueSummaryValue[\s\S]*accountExperienceSummaryValue/s);
  assert.match(accountSummary, /upperDashboard\.renderAccountLevel\(\{[\s\S]*server:\s*formatAccountServerValue\(accountLevel\)[\s\S]*level:\s*valueOrDash\(accountLevel\?\.level\)[\s\S]*experience:\s*formatAccountLevelProgress\(accountLevel \|\| \{\}\)/s);
  assert.match(script, /\{ label: "经验保护"/);
  assert.match(script, /experienceGuard:\s*buildExperienceGuardQueueView\(/);
  assert.ok(percentIndex >= 0, "percentage input is rendered in the automation card");
  assert.ok(percentIndex < statusIndex, "status follows percentage input");
  assert.ok(statusIndex < lineIndex, "guard line follows status");
  assert.ok(lineIndex < distanceIndex, "distance follows guard line");
  assert.match(experienceGuardCard, /experience-guard-queue-card/);
  assert.match(experienceGuardCard, /"experienceGuardThresholdInput"/);
  assert.match(experienceGuardCard, /type:\s*"number"/);
  assert.match(experienceGuardCard, /min:\s*"0"/);
  assert.match(experienceGuardCard, /step:\s*"0\.01"/);
  assert.match(queueView, /record\.input, "disabled", view\.inputDisabled/);
  assert.doesNotMatch(riskSummary, /经验保护门槛/);
  for (const label of ["错误数", "状态", "登录态", "凭据"]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(riskSummary, /upperDashboard\.renderSummary\(\{[\s\S]*risks:\s*\{[\s\S]*errors:[\s\S]*status:[\s\S]*login:[\s\S]*credentials:/s);
  assert.match(styles, /\.experience-guard-panel\s*\{[^}]*display:\s*grid/s);
  assert.match(styles, /\.experience-guard-field\s*\{[^}]*justify-content:\s*flex-start/s);
  assert.match(styles, /\.experience-guard-field strong\s*\{[^}]*text-align:\s*left/s);
  assert.match(styles, /\.experience-guard-percent-control\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(styles, /\.experience-guard-queue-card \.experience-guard-panel\s*\{[^}]*grid-template-columns:\s*1fr/s);
});

test("console monitor shows actionable main task details instead of generic queue text", async () => {
  const [script, queueView] = await Promise.all([
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
  ]);

  assert.match(script, /function buildMainTaskQueueView\(/);
  assert.match(queueView, /function createMainTaskCard\(/);
  assert.match(queueView, /function patchMainTaskCard\(/);
  assert.match(script, /mainTaskStatus/);
  assert.match(script, /taskId/);
  assert.match(script, /taskType/);
  assert.match(script, /desc/);
  assert.match(script, /progressText/);
  assert.match(script, /remainingValue/);
  assert.match(script, /canReceive/);
  assert.match(queueView, /任务详情/);
  assert.match(queueView, /还差/);
  assert.match(script, /可领取/);
  assert.match(script, /当前主线任务是种植任务，自动化会等土地成熟\/空地出现后继续推进；当前不可领取/);
});

test("console surfaces login-state auto stop without marking credentials missing", async () => {
  const [html, script, queueView, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "queue-dashboard-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  assert.match(html, /id="automationStopBanner"/);
  assert.match(html, /id="automationStopTitle"/);
  assert.match(html, /id="automationStopMessage"/);
  assert.match(queueView, /function patchStopBanner\(/);
  assert.match(script, /getLoginStopInfo/);
  assert.match(script, /已自动停止：登录态失效/);
  assert.match(script, /账号可能在手机端登录，建议先验证账号，再重新启动循环。/);
  assert.match(script, /登录态/);
  assert.match(script, /已失效/);
  assert.match(script, /待验证/);
  assert.match(script, /手机端登录/);
  assert.match(script, /验证账号/);
  assert.match(styles, /\.automation-stop-banner/);
  assert.match(styles, /\.automation-stop-banner\.visible/);
});

test("console embeds a collapsible remote access settings panel next to the topbar", async () => {
  const [html, script, view, styles] = await Promise.all([
    readFile(path.join(publicDir, "index.html"), "utf8"),
    readFile(path.join(publicDir, "app.js"), "utf8"),
    readFile(path.join(publicDir, "allowed-hosts-view.js"), "utf8"),
    readFile(path.join(publicDir, "styles.css"), "utf8"),
  ]);

  const topbarActionsStart = html.indexOf("class=\"topbar-actions\"");
  const buttonIndex = html.indexOf('id="remoteAccessButton"');
  const panelIndex = html.indexOf('id="remoteAccessPanel"');
  assert.ok(buttonIndex > topbarActionsStart, "remote access button lives in the topbar actions");
  assert.match(html, />远程访问设置<\/button>/);
  assert.ok(panelIndex > 0, "remote access panel is embedded in the page");
  assert.ok(panelIndex > html.indexOf("</header>"), "panel is below the topbar header");
  assert.match(html, /id="allowedHostsInput"/);
  assert.match(html, /id="saveAllowedHostsButton"/);
  assert.match(html, /远程访问设置/);
  assert.match(html, /逗号分隔/);
  assert.doesNotMatch(html, /<dialog[^>]*remoteAccessPanel/);
  assert.doesNotMatch(html, /<dialog[\s\S]*?id="remoteAccessPanel"/);

  assert.match(script, /api\("\/api\/system\/settings"\)/);
  assert.match(script, /api\("\/api\/system\/settings",\s*\{\s*method: "POST"/);
  assert.match(script, /function loadSystemSettings\(/);
  assert.match(script, /function saveAllowedHosts\(/);
  assert.match(script, /parseAllowedHostsInput/);
  assert.match(script, /formatAllowedHostsInput/);
  assert.match(script, /on\("remoteAccessButton", "click"/);
  assert.match(script, /on\("saveAllowedHostsButton", "click"/);
  assert.match(script, /remoteAccessPanel/);
  assert.match(script, /仅本机可访问/);

  assert.match(view, /export function parseAllowedHostsInput\(/);
  assert.match(view, /export function formatAllowedHostsInput\(/);
  assert.match(styles, /\.remote-access-panel/);
  assert.match(styles, /\.remote-access-panel\[hidden\]\s*{\s*display:\s*none/);
});
