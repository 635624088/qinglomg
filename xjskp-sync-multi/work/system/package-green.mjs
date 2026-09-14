import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_FILES = [
  "package.json",
  "README.md",
  "client-analysis/latest.json",
  "start-system.cmd",
  "stop-system.cmd",
  "reset-auto-plant-secrets.cmd",
  "run-auto-plant.cmd",
  "run-auto-plant-once.cmd",
  "启动系统.cmd",
  "停止系统.cmd",
  "重置账号凭据.cmd",
  "查询最新游戏版本.cmd",
  "打包绿色版.cmd",
];

const WORK_FILES = [
  "account-level-config.mjs",
  "account-command-gateway.mjs",
  "account-scheduler.mjs",
  "automation-module-health.mjs",
  "automation-stop.mjs",
  "cyclic-note-state.mjs",
  "cyclic-story-state.mjs",
  "experience-settlement.mjs",
  "experience-guard-state.mjs",
  "extract-flower-names.mjs",
  "flower-level-config.mjs",
  "flower-upgrade-state.mjs",
  "flower-names.json",
  "flower-rack-state.mjs",
  "flower-source-state.mjs",
  "fml-land-state.mjs",
  "free-water-state.mjs",
  "game-data-version.mjs",
  "game-data-compatibility.mjs",
  "game-data-candidate-sync.mjs",
  "automation-game-contract.mjs",
  "game-code-version.mjs",
  "game-code-compatibility.mjs",
  "game-release-candidate-sync.mjs",
  "game-release-version.mjs",
  "garden-state.mjs",
  "inspect-garden-dryrun.mjs",
  "loop-interval.mjs",
  "main-task-state.mjs",
  "material-shop-state.mjs",
  "official-game-info.mjs",
  "order-status-document.mjs",
  "order-state.mjs",
  "pearl-state.mjs",
  "package-system.ps1",
  "query-official-game-version.mjs",
  "rate-limit-guard.mjs",
  "reset-system-accounts.ps1",
  "run-auto-plant.ps1",
  "run-history.mjs",
  "start-system.ps1",
  "static-config-path.mjs",
  "status-format.mjs",
  "status-format-html.mjs",
  "status-artifact-writer.mjs",
  "status-artifact-fingerprint.mjs",
  "runtime-artifact-completion.mjs",
  "stop-system.ps1",
  "sync-latest-static-config.mjs",
  "sync-latest-static-config.ps1",
  "team-order-archive.mjs",
  "team-order-experience-history.mjs",
  "team-order-runner.mjs",
  "team-order-state.mjs",
  "waterwheel-state.mjs",
  "waterwheel-bucket-state.mjs",
  "water-drop-status.mjs",
  "latest-game-info.json",
];

const DATA_PATTERNS = [
  /^g-data\..*\.text$/i,
  /^resources-config-.*\.json$/i,
  /^resources-pack-.*\.json$/i,
  /^game-pkg-.*\.bin$/i,
];

const WORK_DIRECTORIES = [
  "game-pkg-latest",
  "game-pkg",
];

const PORTABLE_MARKER_FILE = "PORTABLE-RUNTIME.txt";
const RUNTIME_DIRS_TO_PRESERVE = [
  "accounts",
  "status",
  "logs",
  "settings",
  "game-data",
  "game-code",
  path.join("system", "desired-runs"),
  path.join("system", "experience-guards"),
  path.join("system", "waterwheel-buckets"),
  path.join("system", "canonical-migration-backups"),
  path.join("system", "account-reset"),
];
const MIN_ZIP_FILE_DATE = new Date(1980, 0, 1, 0, 0, 0);

export function buildPackagePlan({ rootDir, outputDir, nodeExe }) {
  rootDir = path.resolve(rootDir);
  outputDir = path.resolve(outputDir || defaultPackageOutputDir(rootDir));

  const entries = [];
  const seen = new Set();
  const addEntry = (entry) => {
    const key = entry.to.replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(entry);
  };

  for (const file of ROOT_FILES) {
    addEntry({ from: path.join(rootDir, file), to: file, optional: true });
  }
  for (const file of WORK_FILES) {
    addEntry({ from: path.join(rootDir, "work", file), to: path.join("work", file), optional: true });
  }
  for (const file of discoverWorkDataFiles(rootDir)) {
    addEntry({ from: path.join(rootDir, "work", file), to: path.join("work", file), optional: true });
  }
  for (const file of discoverRelativeFiles(path.join(rootDir, "work", "system"))) {
    addEntry({
      from: path.join(rootDir, "work", "system", file),
      to: path.join("work", "system", file),
    });
  }
  for (const dir of WORK_DIRECTORIES) {
    for (const file of discoverRelativeFiles(path.join(rootDir, "work", dir))) {
      addEntry({
        from: path.join(rootDir, "work", dir, file),
        to: path.join("work", dir, file),
      });
    }
  }
  addEntry({ from: nodeExe, to: path.join("bin", "node", "node.exe") });
  return { rootDir, outputDir, entries };
}

export async function createGreenPackage({ rootDir, outputDir, nodeExe }) {
  const plan = buildPackagePlan({ rootDir, outputDir, nodeExe });
  if (path.resolve(plan.rootDir) === path.resolve(plan.outputDir)) {
    throw new Error("Refusing to package over the current runtime root.");
  }

  const preservedRuntimeDir = await preserveExistingRuntime(plan.outputDir);
  await fs.rm(plan.outputDir, { recursive: true, force: true });
  await fs.mkdir(plan.outputDir, { recursive: true });

  for (const entry of plan.entries) {
    try {
      const target = path.join(plan.outputDir, entry.to);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(entry.from, target);
      await normalizePortableFileTimestamp(target);
    } catch (err) {
      if (entry.optional && err.code === "ENOENT") continue;
      throw err;
    }
  }

  await restoreRuntimeData({
    rootDir: plan.rootDir,
    outputDir: plan.outputDir,
    preservedRuntimeDir,
  });
  await fs.mkdir(path.join(plan.outputDir, "runtime", "system"), { recursive: true });
  await fs.writeFile(path.join(plan.outputDir, PORTABLE_MARKER_FILE), buildPortableMarker(), "utf8");
  await fs.writeFile(path.join(plan.outputDir, "README-RUN.txt"), buildRunReadme(), "utf8");
  return plan;
}

export function defaultPackageOutputDir(rootDir) {
  return path.join(rootDir, "release", "xjskp-sync-multi-next");
}

function discoverWorkDataFiles(rootDir) {
  try {
    return Array.from(fsSync.readdirSync(path.join(rootDir, "work")))
      .filter((name) => DATA_PATTERNS.some((pattern) => pattern.test(name)));
  } catch {
    return [];
  }
}

function discoverRelativeFiles(dir, base = dir) {
  try {
    const result = [];
    for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
      if (!shouldIncludeDirectoryEntry(entry)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...discoverRelativeFiles(fullPath, base));
      } else {
        result.push(path.relative(base, fullPath));
      }
    }
    return result;
  } catch {
    return [];
  }
}

function shouldIncludeDirectoryEntry(entry) {
  if (entry.name === ".tmp") return false;
  return true;
}

function buildRunReadme() {
  return [
    "鲜花小镇自动化控制台",
    "",
    "1. 双击 start-system.cmd 或 启动系统.cmd。",
    "2. 第一次使用时，在浏览器控制台导入账号凭据。",
    "3. 在页面内启动循环、停止任务、执行一轮或只查订单。",
    "4. 多账号并行：在控制台勾选账号后点击“启动所选账号”；不会自动补选、导入或验证账号。",
    "5. 默认不限制同时运行的账号数；如需显式限流，可设置 XJSKP_MAX_PARALLEL_TASKS。",
    "6. run-auto-plant.cmd 仍是单账号兼容入口，不作为多账号启动方式。",
    "7. 双击 stop-system.cmd 或 停止系统.cmd 可关闭本地服务和托管任务。",
    "8. 先停止系统，再双击 重置账号凭据.cmd；它只清除凭据和运行时残留，保留账号卡与设置，并支持按 operationId 恢复。",
    "9. 后续运行和修复都以这个绿色包目录为准。",
    "",
    "升级到另一台机器：先停止全部任务，再覆盖完整绿色包程序文件（bin、work、根目录启动脚本、package.json、client-analysis），不要只复制 work。",
    "目标机器的 runtime 必须保留或合并：accounts、settings、status、game-data、game-code 和 system；覆盖后重启系统并在浏览器强制刷新。",
    "",
  ].join("\r\n");
}

function buildPortableMarker() {
  return [
    "xjskp-sync-multi-next portable runtime",
    "This marker makes copied start scripts run from this folder instead of the source checkout.",
    "",
  ].join("\r\n");
}

async function preserveExistingRuntime(outputDir) {
  const runtimeDir = path.join(outputDir, "runtime");
  if (!(await pathExists(runtimeDir))) return null;

  const preserveDir = path.join(path.dirname(outputDir), `.runtime-preserve-${process.pid}-${Date.now()}`);
  await fs.mkdir(preserveDir, { recursive: true });
  for (const name of RUNTIME_DIRS_TO_PRESERVE) {
    const source = path.join(runtimeDir, name);
    if (await pathExists(source)) {
      await fs.cp(source, path.join(preserveDir, name), { recursive: true, preserveTimestamps: true });
    }
  }
  return preserveDir;
}

async function restoreRuntimeData({ rootDir, outputDir, preservedRuntimeDir }) {
  const sourceRuntimeDirs = await runtimeRestoreSources({ rootDir, outputDir, preservedRuntimeDir });
  for (const name of RUNTIME_DIRS_TO_PRESERVE) {
    const target = path.join(outputDir, "runtime", name);
    for (const sourceRuntimeDir of sourceRuntimeDirs) {
      const source = path.join(sourceRuntimeDir, name);
      if (await pathExists(source)) {
        const preservedExperienceGuardWins = Boolean(
          preservedRuntimeDir
          && path.resolve(sourceRuntimeDir) === path.resolve(preservedRuntimeDir)
          && name === path.join("system", "experience-guards"),
        );
        await mergeDirectory(source, target, {
          overwriteExisting: preservedExperienceGuardWins,
        });
      }
    }
    await fs.mkdir(target, { recursive: true });
  }
  if (preservedRuntimeDir) {
    await fs.rm(preservedRuntimeDir, { recursive: true, force: true });
  }
}

async function runtimeRestoreSources({ rootDir, outputDir, preservedRuntimeDir }) {
  const sources = [];
  const addSource = async (dir) => {
    if (!dir) return;
    const resolved = path.resolve(dir);
    if (sources.some((source) => path.resolve(source) === resolved)) return;
    if (await pathExists(resolved)) sources.push(resolved);
  };

  const canonicalRuntimeDir = path.join(defaultPackageOutputDir(rootDir), "runtime");
  const outputRuntimeDir = path.join(outputDir, "runtime");
  const outputIsCanonical = path.resolve(canonicalRuntimeDir) === path.resolve(outputRuntimeDir);
  if (outputIsCanonical) {
    await addSource(preservedRuntimeDir);
    await addSource(path.join(rootDir, "runtime"));
  } else {
    await addSource(canonicalRuntimeDir);
    await addSource(preservedRuntimeDir);
  }
  if (!sources.length) {
    await addSource(path.join(rootDir, "runtime"));
  }
  return sources;
}

async function mergeDirectory(sourceDir, targetDir, options = {}) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await fs.readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mergeDirectory(source, target, options);
      continue;
    }
    if (!entry.isFile()) continue;
    if (options.overwriteExisting || await shouldCopyRuntimeFile(source, target)) {
      await copyFilePreservingTimes(source, target);
    }
  }
}

async function shouldCopyRuntimeFile(source, target) {
  try {
    const [sourceStat, targetStat] = await Promise.all([fs.stat(source), fs.stat(target)]);
    return sourceStat.mtimeMs >= targetStat.mtimeMs;
  } catch (err) {
    if (err.code === "ENOENT") return true;
    throw err;
  }
}

async function copyFilePreservingTimes(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stat = await fs.stat(source);
  await fs.copyFile(source, target);
  await fs.utimes(target, stat.atime, stat.mtime);
}

async function normalizePortableFileTimestamp(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.mtime >= MIN_ZIP_FILE_DATE) return;
  await fs.utimes(filePath, MIN_ZIP_FILE_DATE, MIN_ZIP_FILE_DATE);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const args = {};
  for (const arg of argv) {
    if (arg.startsWith("--root=")) args.rootDir = arg.slice("--root=".length);
    if (arg.startsWith("--out=")) args.outputDir = arg.slice("--out=".length);
    if (arg.startsWith("--node=")) args.nodeExe = arg.slice("--node=".length);
  }
  return args;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(args.rootDir || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const outputDir = path.resolve(args.outputDir || defaultPackageOutputDir(rootDir));
  const nodeExe = path.resolve(args.nodeExe || process.execPath);
  await createGreenPackage({ rootDir, outputDir, nodeExe });
  console.log(`Portable package created: ${outputDir}`);
}
