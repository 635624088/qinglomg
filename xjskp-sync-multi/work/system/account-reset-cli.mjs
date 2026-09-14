import * as defaultFs from "node:fs/promises";
import { execFile as defaultExecFile } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { createAccountResetService } from "./account-reset-service.mjs";
import { createProfileStore } from "./profile-store.mjs";
import {
  acquireServerSingletonGuard,
  resolveServerGuardIdentity,
} from "./server-singleton-guard.mjs";
import { readServerLock } from "./runtime-lock.mjs";

const CONFIRMATION_TEXT = "RESET-CREDENTIALS";

export async function runAccountResetCli(options = {}) {
  const args = parseArgs(options.args || process.argv.slice(2));
  const rootDir = path.resolve(args.rootDir || options.rootDir || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const runtimeDir = path.resolve(args.runtimeDir || options.runtimeDir || path.join(rootDir, "runtime"));
  const output = options.output || ((message) => process.stdout.write(`${message}\n`));
  const fs = options.fs || defaultFs;
  const profileStore = options.profileStore || createProfileStore({ accountsDir: path.join(runtimeDir, "accounts") });
  const service = options.service || createAccountResetService({ runtimeDir, profileStore, fs });
  const identityResolver = options.identityResolver || resolveServerGuardIdentity;
  const guardFactory = options.guardFactory || acquireServerSingletonGuard;
  const inspectOwner = options.inspectOwner || ((identity) => inspectResetOwner({
    runtimeDir,
    rootDir,
    identity,
    fs,
    fetchFn: options.fetchFn || fetch,
  }));
  const inspectProcesses = options.processInspector || (() => inspectRelatedProcesses({
    rootDir,
    execFileFn: options.execFileFn,
    platform: options.platform,
  }));

  let preview = null;
  if (!args.resumeOperationId) {
    preview = await service.plan(args.profileIds.length ? args.profileIds : "all");
    printPlan(output, preview);
    const confirmed = args.confirmation === CONFIRMATION_TEXT
      || await requestConfirmation(options.confirmFn, output);
    if (!confirmed) {
      output("已取消，未修改任何文件。");
      return { state: "cancelled", targets: preview.targets.length };
    }
  }

  const identity = await identityResolver(runtimeDir);
  const ownerBefore = await inspectOwner(identity);
  throwIfRuntimeOwner(ownerBefore);
  let guard;
  try {
    guard = await guardFactory({
      runtimeDir,
      identity,
      inspectOwner: () => inspectOwner(identity),
      timeoutMs: 1_500,
    });
    const ownerAfter = await inspectOwner(identity);
    throwIfRuntimeOwner(ownerAfter);
    const relatedProcesses = await inspectProcesses();
    if (relatedProcesses.length) {
      throw createCliError(
        "ACCOUNT_RESET_WORKER_RUNNING",
        `仍有相关自动化进程：${relatedProcesses.map((item) => `${item.name || "process"}(${item.pid})`).join(", ")}。请先使用停止系统入口。`,
      );
    }

    const validateQuiescent = async (plan) => {
      const activeTargets = plan.targets.filter((target) => (
        target.artifacts.some((artifact) => artifact.kind === "active-task")
      ));
      if (!activeTargets.length) return;
      throw createCliError(
        "PROFILE_RESET_REQUIRES_STOP",
        `存在未解析的 active-task：${activeTargets.map((target) => target.profileId).join(", ")}。请先停止任务并确认状态已收敛。`,
      );
    };

    let result;
    if (args.resumeOperationId) {
      output(`恢复凭据重置事务：${args.resumeOperationId}`);
      result = await service.resume(args.resumeOperationId, { validateQuiescent });
    } else {
      const committedPlan = await service.plan(args.profileIds.length ? args.profileIds : "all");
      if (!samePlan(preview, committedPlan)) {
        throw createCliError(
          "ACCOUNT_RESET_PLAN_CHANGED",
          "确认后运行时清单发生变化，已中止且未写入；请重新执行并确认最新清单。",
        );
      }
      result = await service.execute(committedPlan, { validateQuiescent });
    }
    const verified = await service.verify(result.operationId);
    output(`凭据重置完成：operationId=${verified.operationId}，targets=${verified.targets.length}`);
    return verified;
  } finally {
    await guard?.release?.();
  }
}

function parseArgs(argv) {
  const parsed = {
    rootDir: null,
    runtimeDir: null,
    confirmation: null,
    resumeOperationId: null,
    profileIds: [],
  };
  for (const rawArg of argv) {
    const arg = String(rawArg || "");
    if (arg.startsWith("--root=")) parsed.rootDir = arg.slice("--root=".length);
    else if (arg.startsWith("--runtime=")) parsed.runtimeDir = arg.slice("--runtime=".length);
    else if (arg.startsWith("--confirm=")) parsed.confirmation = arg.slice("--confirm=".length);
    else if (arg.startsWith("--resume=")) parsed.resumeOperationId = arg.slice("--resume=".length);
    else if (arg.startsWith("--profile=")) parsed.profileIds.push(arg.slice("--profile=".length));
    else throw createCliError("ACCOUNT_RESET_ARGUMENT_INVALID", `未知参数：${arg}`);
  }
  return parsed;
}

function printPlan(output, plan) {
  output(`将重置 ${plan.targets.length} 个账号/运行时目标的凭据：`);
  for (const target of plan.targets) {
    const kinds = [...new Set(target.artifacts.map((artifact) => artifact.kind))].join(", ") || "none";
    output(`- ${target.profileId}${target.profilePresent ? "" : "（仅残留运行时数据）"}: ${kinds}`);
  }
  output("账号卡、设置和版本字段会保留；运行时控制残留会清理，状态与日志会归档。");
}

function samePlan(left, right) {
  return planFingerprint(left) === planFingerprint(right);
}

function planFingerprint(plan) {
  return JSON.stringify((plan?.targets || []).map((target) => ({
    profileId: target.profileId,
    profilePresent: target.profilePresent,
    rawIds: target.rawIds,
    artifacts: target.artifacts.map((artifact) => ({
      kind: artifact.kind,
      relativePath: artifact.relativePath,
      rawProfileId: artifact.rawProfileId,
    })),
  })));
}

async function requestConfirmation(confirmFn, output) {
  if (confirmFn) return await confirmFn(CONFIRMATION_TEXT);
  if (!process.stdin.isTTY) {
    throw createCliError(
      "ACCOUNT_RESET_CONFIRMATION_REQUIRED",
      `非交互运行必须显式传入 --confirm=${CONFIRMATION_TEXT}`,
    );
  }
  output(`请输入 ${CONFIRMATION_TEXT} 确认；其他输入均取消。`);
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question("> ")).trim() === CONFIRMATION_TEXT;
  } finally {
    terminal.close();
  }
}

async function inspectResetOwner({ runtimeDir, rootDir, identity, fs, fetchFn }) {
  let lock;
  try {
    lock = await readServerLock(runtimeDir);
  } catch {
    return null;
  }
  const port = Number(lock?.port);
  if (!lock || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const response = await fetchFn(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const health = await response.json();
    if (Number(health?.pid) !== Number(lock.pid) || Number(health?.port) !== port) return null;
    if (Number(lock.version) === 1 && samePath(lock.rootDir, rootDir)) {
      return { status: "legacy", version: 1, healthy: true, pid: Number(lock.pid), port };
    }
    if (Number(lock.version) !== 2 || Number(health?.version) !== 2) return null;
    if (lock.instanceId !== health.instanceId || lock.canonicalRuntimeDir !== identity.canonicalRuntimeDir) return null;
    if (lock.guardName !== identity.guardName || health.guardName !== identity.guardName) return null;
    return { status: lock.lifecycle === "ready" ? "ready" : lock.lifecycle, version: 2, healthy: true, pid: Number(lock.pid), port };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function inspectRelatedProcesses(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return [];
  const rootDir = path.resolve(options.rootDir).replaceAll("'", "''");
  const command = [
    `$root = '${rootDir}'.ToLowerInvariant();`,
    "$self = $PID;",
    `$parent = ${process.pid};`,
    "$items = @(Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ProcessId -ne $self -and $_.ProcessId -ne $parent -and $_.CommandLine -and",
    "  $_.CommandLine.ToLowerInvariant().Contains($root) -and",
    "  ($_.CommandLine -match 'server\\.mjs|automation-worker\\.mjs|inspect-garden-dryrun\\.mjs|run-auto-plant\\.ps1')",
    "} | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='name';e={$_.Name}});",
    "$items | ConvertTo-Json -Compress",
  ].join(" ");
  const execFileAsync = options.execFileFn
    ? (...args) => new Promise((resolve, reject) => options.execFileFn(...args, (error, stdout, stderr) => (
      error ? reject(Object.assign(error, { stderr })) : resolve({ stdout, stderr })
    )))
    : promisify(defaultExecFile);
  let stdout;
  try {
    ({ stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", command], {
      windowsHide: false,
      timeout: 5_000,
      encoding: "utf8",
    }));
  } catch (error) {
    throw createCliError("ACCOUNT_RESET_PROCESS_CHECK_FAILED", `无法确认相关进程已停止：${error?.message || error}`);
  }
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.pid),
    name: String(item.name || ""),
  }));
}

function throwIfRuntimeOwner(owner) {
  if (!owner?.healthy) return;
  throw createCliError(
    "ACCOUNT_RESET_SERVER_RUNNING",
    `本地服务仍在运行（pid=${owner.pid || "-"}，port=${owner.port || "-"}）。请先使用停止系统入口。`,
  );
}

function samePath(left, right) {
  return path.resolve(String(left || "")).toLowerCase() === path.resolve(String(right || "")).toLowerCase();
}

function createCliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  runAccountResetCli().catch((error) => {
    process.stderr.write(`凭据重置失败 [${error?.code || "ACCOUNT_RESET_FAILED"}]：${error?.message || error}\n`);
    if (error?.operationId) {
      process.stderr.write(`恢复命令：node "${fileURLToPath(import.meta.url)}" --resume=${error.operationId}\n`);
    }
    process.exitCode = 1;
  });
}
