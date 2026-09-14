import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildPackagePlan, createGreenPackage } from "./system/package-green.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

function getRelativeRuntimeSpecifiers(source) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["'](\.[^"']+)["']/g,
    /import\(\s*["'](\.[^"']+)["']\s*\)/g,
    /new URL\(\s*["'](\.[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1]);
  }
  return specifiers;
}

test("buildPackagePlan defaults to the canonical release package directory", () => {
  const rootDir = repoRoot;
  const plan = buildPackagePlan({ rootDir, nodeExe: "C:\\node\\node.exe" });

  assert.equal(
    path.normalize(plan.outputDir),
    path.join(rootDir, "release", "xjskp-sync-multi-next"),
  );
});

test("buildPackagePlan keeps the portable package focused on runtime files", () => {
  const rootDir = repoRoot;
  const outputDir = path.join(rootDir, "release", "xjskp-sync-multi-next");
  const plan = buildPackagePlan({ rootDir, outputDir, nodeExe: "C:\\node\\node.exe" });
  const destinations = plan.entries.map((entry) => entry.to.replace(/\\/g, "/"));

  assert(destinations.includes("package.json"));
  assert(destinations.includes("启动系统.cmd"));
  assert(destinations.includes("查询最新游戏版本.cmd"));
  assert(destinations.includes("client-analysis/latest.json"));
  assert(destinations.includes("work/system/server.mjs"));
  assert(destinations.includes("work/system/public/profile-settings-client.js"));
  assert(destinations.includes("work/system/public/game-version-view.js"));
  assert(destinations.includes("work/package-system.ps1"));
  assert(destinations.includes("work/inspect-garden-dryrun.mjs"));
  assert(destinations.includes("work/waterwheel-bucket-state.mjs"));
  assert(destinations.includes("work/game-data-version.mjs"));
  assert(destinations.includes("work/game-data-compatibility.mjs"));
  assert(destinations.includes("work/game-data-candidate-sync.mjs"));
  assert(destinations.includes("work/automation-game-contract.mjs"));
  assert(destinations.includes("work/game-code-version.mjs"));
  assert(destinations.includes("work/game-code-compatibility.mjs"));
  assert(destinations.includes("work/game-release-candidate-sync.mjs"));
  assert(destinations.includes("work/game-release-version.mjs"));
  assert(destinations.includes("work/account-level-config.mjs"));
  assert(destinations.includes("work/account-command-gateway.mjs"));
  assert(destinations.includes("work/account-scheduler.mjs"));
  assert(destinations.includes("work/experience-guard-state.mjs"));
  assert(destinations.includes("work/flower-upgrade-state.mjs"));
  assert(destinations.includes("work/status-format-html.mjs"));
  assert(destinations.includes("work/status-artifact-writer.mjs"));
  assert(destinations.includes("work/status-artifact-fingerprint.mjs"));
  assert(destinations.includes("work/runtime-artifact-completion.mjs"));
  assert(destinations.includes("work/water-drop-status.mjs"));
  assert(destinations.includes("work/order-status-document.mjs"));
  assert(destinations.includes("work/automation-stop.mjs"));
  assert(destinations.includes("work/official-game-info.mjs"));
  assert(destinations.includes("work/query-official-game-version.mjs"));
  assert(destinations.includes("work/cyclic-note-state.mjs"));
  assert(destinations.includes("work/cyclic-story-state.mjs"));
  assert(destinations.includes("work/team-order-state.mjs"));
  assert(destinations.includes("work/team-order-runner.mjs"));
  assert(destinations.includes("work/team-order-archive.mjs"));
  assert(destinations.includes("work/experience-settlement.mjs"));
  assert(destinations.includes("work/team-order-experience-history.mjs"));
  assert(destinations.includes("work/g-data.fe15e.text"));
  assert(destinations.includes("work/game-pkg-latest/Manifest.xml"));
  assert(destinations.includes("work/game-pkg-latest/tar/game.js"));
  assert(destinations.includes("work/game-pkg-latest/tar/modules.json"));
  assert(destinations.includes("bin/node/node.exe"));

  assert.equal(destinations.some((item) => item.startsWith("outputs/")), false);
  assert.equal(destinations.some((item) => item.includes("site-inspect/")), false);
  assert.equal(destinations.some((item) => item.endsWith(".test.mjs")), false);
  assert.equal(destinations.some((item) => item.includes(".t1.red.")), false);
  assert.equal(destinations.some((item) => item.includes("work/fixtures/")), false);
  assert.deepEqual(
    destinations.filter((item) => item.startsWith("client-analysis/")),
    ["client-analysis/latest.json"],
  );
  assert.equal(destinations.some((item) => item.includes("generate-flower")), false);
});

test("buildPackagePlan closes over relative runtime imports", async () => {
  const plan = buildPackagePlan({
    rootDir: repoRoot,
    outputDir: path.join(repoRoot, "release", "xjskp-sync-multi-next"),
    nodeExe: "C:\\node\\node.exe",
  });
  const destinations = new Set(
    plan.entries.map((entry) => entry.to.replace(/\\/g, "/")),
  );
  const pending = [
    "work/system/server.mjs",
    "work/inspect-garden-dryrun.mjs",
    "work/query-official-game-version.mjs",
    "work/sync-latest-static-config.mjs",
  ];
  const visited = new Set();
  const missing = [];

  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    const source = await fs.readFile(path.join(repoRoot, current), "utf8");
    for (const specifier of getRelativeRuntimeSpecifiers(source)) {
      const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(current), cleanSpecifier),
      );
      if (!destinations.has(resolved)) {
        missing.push({ from: current, specifier, resolved });
        continue;
      }
      if (/\.(?:mjs|js)$/i.test(resolved)) pending.push(resolved);
    }
  }

  assert.deepEqual(missing, []);
});

test("createGreenPackage writes a portable marker and readable Chinese run guide", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-package-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const outputDir = path.join(tempRoot, "release", "xjskp-sync-multi-next");
  const nodeExe = path.join(tempRoot, "node.exe");
  const legacyTimestampFile = path.join(tempRoot, "work", "game-pkg", "tar", "_fileList");
  await fs.writeFile(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "启动系统.cmd"), "@echo off\n", "utf8");
  await fs.mkdir(path.dirname(legacyTimestampFile), { recursive: true });
  await fs.writeFile(legacyTimestampFile, "legacy package file list\n", "utf8");
  const legacyDate = new Date("1970-01-01T00:00:00.000Z");
  await fs.utimes(legacyTimestampFile, legacyDate, legacyDate);
  await fs.writeFile(nodeExe, "fake node\n", "utf8");

  await createGreenPackage({ rootDir: tempRoot, outputDir, nodeExe });

  const marker = await fs.readFile(path.join(outputDir, "PORTABLE-RUNTIME.txt"), "utf8");
  const readme = await fs.readFile(path.join(outputDir, "README-RUN.txt"), "utf8");

  assert.match(marker, /xjskp-sync-multi-next/);
  assert.match(readme, /鲜花小镇自动化控制台/);
  assert.match(readme, /多账号并行/);
  assert.match(readme, /默认不限制同时运行的账号数/);
  assert.match(readme, /run-auto-plant\.cmd.*单账号/);
  assert.match(readme, /保留账号卡与设置/);
  assert.match(readme, /不要只复制 work/);
  assert.match(readme, /game-data.*game-code/);
  const packagedLegacyTimestampFile = await fs.stat(path.join(outputDir, "work", "game-pkg", "tar", "_fileList"));
  assert.equal(packagedLegacyTimestampFile.mtime.getFullYear(), 1980);
  await assert.doesNotReject(() => fs.access(path.join(outputDir, "runtime", "accounts")));
});

test("createGreenPackage preserves runtime settings and desired loops when overwriting an existing package", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-package-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const outputDir = path.join(tempRoot, "release", "xjskp-sync-multi-next");
  const nodeExe = path.join(tempRoot, "node.exe");
  const settingsPath = path.join(outputDir, "runtime", "settings", "main.json");
  const desiredPath = path.join(outputDir, "runtime", "system", "desired-runs", "main.json");
  const activeGameDataPointerPath = path.join(outputDir, "runtime", "status", "game-data-active.json");
  const activeGameDataConfigPath = path.join(
    outputDir,
    "runtime",
    "game-data",
    "versions",
    "2f3f6",
    "g-data.2f3f6.text",
  );
  const experienceGuardPath = path.join(outputDir, "runtime", "system", "experience-guards", "main.json");
  const waterwheelBucketPath = path.join(outputDir, "runtime", "system", "waterwheel-buckets", "main.json");
  const experienceGuardSidecars = [
    `${experienceGuardPath}.initialized.json`,
    `${experienceGuardPath}.settlement-pending.json`,
    path.join(path.dirname(experienceGuardPath), "main.rearm.json"),
  ];
  const resetJournalPath = path.join(outputDir, "runtime", "system", "account-reset", "operations", "operation-1.json");
  const migrationRecordPath = path.join(
    outputDir,
    "runtime",
    "system",
    "canonical-migration-backups",
    "records",
    "record-1.json",
  );
  const migrationBackupPath = path.join(
    outputDir,
    "runtime",
    "system",
    "canonical-migration-backups",
    "settings",
    "MAIN.json",
  );
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.mkdir(path.dirname(desiredPath), { recursive: true });
  await fs.writeFile(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "鍚姩绯荤粺.cmd"), "@echo off\n", "utf8");
  await fs.writeFile(nodeExe, "fake node\n", "utf8");
  await fs.writeFile(settingsPath, JSON.stringify({ flowerRackTargetArtId: 305101 }), "utf8");
  await fs.writeFile(desiredPath, JSON.stringify({
    profileId: "main",
    desiredState: "running",
  }), "utf8");
  await fs.mkdir(path.dirname(activeGameDataPointerPath), { recursive: true });
  await fs.mkdir(path.dirname(activeGameDataConfigPath), { recursive: true });
  await fs.writeFile(
    activeGameDataPointerPath,
    JSON.stringify({ schemaVersion: 1, activeDataVersion: "2f3f6" }),
    "utf8",
  );
  await fs.writeFile(activeGameDataConfigPath, "active-game-data", "utf8");
  await fs.mkdir(path.dirname(experienceGuardPath), { recursive: true });
  await fs.writeFile(experienceGuardPath, JSON.stringify({
    version: 1,
    profileId: "main",
    stateRevision: 2,
    breached: true,
  }), "utf8");
  await fs.mkdir(path.dirname(waterwheelBucketPath), { recursive: true });
  await fs.writeFile(waterwheelBucketPath, JSON.stringify({
    version: 1,
    profileId: "main",
    storedBucketCount: 1,
  }), "utf8");
  for (const [index, sidecarPath] of experienceGuardSidecars.entries()) {
    await fs.writeFile(sidecarPath, JSON.stringify({ marker: index + 1 }), "utf8");
  }
  await fs.mkdir(path.dirname(resetJournalPath), { recursive: true });
  await fs.writeFile(resetJournalPath, JSON.stringify({ operationId: "operation-1", state: "incomplete" }), "utf8");
  await fs.mkdir(path.dirname(migrationRecordPath), { recursive: true });
  await fs.mkdir(path.dirname(migrationBackupPath), { recursive: true });
  await fs.writeFile(migrationRecordPath, JSON.stringify({ canonicalId: "main", status: "completed" }), "utf8");
  await fs.writeFile(migrationBackupPath, JSON.stringify({ profileId: "MAIN" }), "utf8");

  await createGreenPackage({ rootDir: tempRoot, outputDir, nodeExe });

  assert.deepEqual(JSON.parse(await fs.readFile(settingsPath, "utf8")), {
    flowerRackTargetArtId: 305101,
  });
  assert.equal(
    JSON.parse(await fs.readFile(desiredPath, "utf8")).desiredState,
    "running",
  );
  assert.equal(
    JSON.parse(await fs.readFile(activeGameDataPointerPath, "utf8")).activeDataVersion,
    "2f3f6",
  );
  assert.equal(await fs.readFile(activeGameDataConfigPath, "utf8"), "active-game-data");
  assert.equal(JSON.parse(await fs.readFile(experienceGuardPath, "utf8")).breached, true);
  assert.equal(JSON.parse(await fs.readFile(waterwheelBucketPath, "utf8")).storedBucketCount, 1);
  for (const [index, sidecarPath] of experienceGuardSidecars.entries()) {
    assert.equal(JSON.parse(await fs.readFile(sidecarPath, "utf8")).marker, index + 1);
  }
  assert.equal(JSON.parse(await fs.readFile(resetJournalPath, "utf8")).state, "incomplete");
  assert.equal(JSON.parse(await fs.readFile(migrationRecordPath, "utf8")).status, "completed");
  assert.equal(JSON.parse(await fs.readFile(migrationBackupPath, "utf8")).profileId, "MAIN");
});

test("createGreenPackage merges current root runtime into the canonical package without older preserved files winning", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-package-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const outputDir = path.join(tempRoot, "release", "xjskp-sync-multi-next");
  const nodeExe = path.join(tempRoot, "node.exe");
  await fs.writeFile(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  await fs.writeFile(nodeExe, "fake node\n", "utf8");

  const oldDate = new Date("2026-01-01T00:00:00.000Z");
  const currentDate = new Date("2026-02-01T00:00:00.000Z");
  const rootRuntimeDir = path.join(tempRoot, "runtime");
  const packagedRuntimeDir = path.join(outputDir, "runtime");
  await writeRuntimeFile(packagedRuntimeDir, "accounts/package-only.json", "package-only", oldDate);
  await writeRuntimeFile(packagedRuntimeDir, "accounts/shared.json", "package-old", oldDate);
  await writeRuntimeFile(packagedRuntimeDir, "settings/shared.json", "package-old", oldDate);
  await writeRuntimeFile(rootRuntimeDir, "accounts/current-only.json", "current-only", currentDate);
  await writeRuntimeFile(rootRuntimeDir, "accounts/shared.json", "current-new", currentDate);
  await writeRuntimeFile(rootRuntimeDir, "settings/current-only.json", "current-only", currentDate);
  await writeRuntimeFile(rootRuntimeDir, "settings/shared.json", "current-new", currentDate);

  await createGreenPackage({ rootDir: tempRoot, outputDir, nodeExe });

  assert.equal(await fs.readFile(path.join(outputDir, "runtime", "accounts", "package-only.json"), "utf8"), "package-only");
  assert.equal(await fs.readFile(path.join(outputDir, "runtime", "accounts", "current-only.json"), "utf8"), "current-only");
  assert.equal(await fs.readFile(path.join(outputDir, "runtime", "settings", "current-only.json"), "utf8"), "current-only");
  assert.equal(await fs.readFile(path.join(outputDir, "runtime", "accounts", "shared.json"), "utf8"), "current-new");
  assert.equal(await fs.readFile(path.join(outputDir, "runtime", "settings", "shared.json"), "utf8"), "current-new");
});

test("createGreenPackage merges canonical runtime accounts into custom output packages", async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-package-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const canonicalOutputDir = path.join(tempRoot, "release", "xjskp-sync-multi-next");
  const outputDir = path.join(tempRoot, "release", "custom-package");
  const nodeExe = path.join(tempRoot, "node.exe");
  await fs.writeFile(path.join(tempRoot, "package.json"), "{}\n", "utf8");
  await fs.writeFile(nodeExe, "fake node\n", "utf8");

  const oldDate = new Date("2026-01-01T00:00:00.000Z");
  const newDate = new Date("2026-02-01T00:00:00.000Z");
  await writeRuntimeFile(path.join(tempRoot, "runtime"), "accounts/root-only.json", "root", oldDate);
  await writeRuntimeFile(path.join(canonicalOutputDir, "runtime"), "accounts/canonical-only.json", "canonical", oldDate);
  await writeRuntimeFile(path.join(canonicalOutputDir, "runtime"), "accounts/shared.json", "canonical-new", newDate);
  await writeRuntimeFile(path.join(outputDir, "runtime"), "accounts/custom-only.json", "custom", oldDate);
  await writeRuntimeFile(path.join(outputDir, "runtime"), "accounts/shared.json", "custom-old", oldDate);
  await writeRuntimeFile(
    path.join(canonicalOutputDir, "runtime"),
    "system/experience-guards/main.json",
    JSON.stringify({ profileId: "main", stateRevision: 3, breached: false }),
    newDate,
  );
  await writeRuntimeFile(
    path.join(outputDir, "runtime"),
    "system/experience-guards/main.json",
    JSON.stringify({ profileId: "main", stateRevision: 10, breached: true }),
    oldDate,
  );

  await createGreenPackage({ rootDir: tempRoot, outputDir, nodeExe });

  const accountDir = path.join(outputDir, "runtime", "accounts");
  await assert.rejects(() => fs.access(path.join(accountDir, "root-only.json")));
  assert.equal(await fs.readFile(path.join(accountDir, "canonical-only.json"), "utf8"), "canonical");
  assert.equal(await fs.readFile(path.join(accountDir, "custom-only.json"), "utf8"), "custom");
  assert.equal(await fs.readFile(path.join(accountDir, "shared.json"), "utf8"), "canonical-new");
  assert.equal(
    JSON.parse(await fs.readFile(
      path.join(outputDir, "runtime", "system", "experience-guards", "main.json"),
      "utf8",
    )).breached,
    true,
  );
});

async function writeRuntimeFile(runtimeDir, relativePath, content, mtime) {
  const filePath = path.join(runtimeDir, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
  await fs.utimes(filePath, mtime, mtime);
}
