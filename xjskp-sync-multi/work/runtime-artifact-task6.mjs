import { readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { createRuntimeArtifactBaseline } from "./runtime-artifact-baseline.mjs";

const FIXTURE_DURATION_MS = 15_000;
const FIXTURE_INTERVAL_MS = 5_000;
const FIXTURE_ARTIFACT_TARGETS = Object.freeze([
  "garden-status.json",
  "garden-status.html",
  "garden-status.md",
]);

const AREAS = Object.freeze(["status", "logs", "accounts", "system", "settings", "unknown"]);

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function artifactArea(relativePath) {
  const first = relativePath.split("/")[0];
  return AREAS.includes(first) ? first : "unknown";
}

function recordInvariantFixtureMetrics(recorder) {
  recorder.recordGameRequest({
    atMs: 0,
    iface: "gs.usr.heartTick",
    args: {},
    trigger: "online-heartbeat",
  });
  recorder.recordSystemLog({
    atMs: 0,
    level: "info",
    step: "onlineHeartbeat",
    message: "offline fixture",
    raw: "offline-runtime-artifact-log\n",
  });
  recorder.recordFullStatusRead({
    atMs: 0,
    trigger: "first-open",
    files: ["garden-status.json", "order-status.json"],
    parsedFiles: 2,
    responseBytes: 256,
  });
  recorder.recordLifecycleEvent({
    event: "first-complete-persist",
    emittedAtMs: 100,
    domVisibleAtMs: 140,
    source: "offline-fixture",
    fullReadCount: 1,
  });
}

function runOfflineFixture({ fixedProjectionWrites }) {
  const recorder = createRuntimeArtifactBaseline({ profileId: "task6-offline-fixture" });
  if (fixedProjectionWrites) {
    for (let atMs = 0; atMs < FIXTURE_DURATION_MS; atMs += FIXTURE_INTERVAL_MS) {
      recorder.recordArtifactBuild({
        atMs,
        reason: "fixed-status-projection",
        files: FIXTURE_ARTIFACT_TARGETS.map((target) => ({
          path: target,
          content: `${target}:${atMs}`,
        })),
        buildDurationMs: 2,
        queueLength: 1,
      });
    }
  }
  recordInvariantFixtureMetrics(recorder);
  return recorder.snapshot();
}

export function buildOfflineRuntimeArtifactOptimizationComparison() {
  const baseline = runOfflineFixture({ fixedProjectionWrites: true });
  const optimized = runOfflineFixture({ fixedProjectionWrites: false });
  return {
    fixture: {
      durationMs: FIXTURE_DURATION_MS,
      statusRefreshIntervalMs: FIXTURE_INTERVAL_MS,
      artifactTargets: [...FIXTURE_ARTIFACT_TARGETS],
      businessChanges: 0,
    },
    baseline,
    optimized,
    delta: {
      artifactBuildCount: optimized.artifact.buildCount - baseline.artifact.buildCount,
      logicalWriteBytes: optimized.artifact.logicalWriteBytes - baseline.artifact.logicalWriteBytes,
      actualReplaceCount: optimized.artifact.actualReplaceCount - baseline.artifact.actualReplaceCount,
    },
  };
}

export async function collectRuntimeTempDryRun(rootDir, {
  nowMs = Date.now(),
  staleAfterMs = 24 * 60 * 60 * 1000,
} = {}) {
  const resolvedRoot = path.resolve(String(rootDir));
  const files = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".tmp")) continue;
      const details = await stat(filePath);
      const relativePath = path.relative(resolvedRoot, filePath).replaceAll("\\", "/");
      const ageMs = Math.max(0, Number(nowMs) - details.mtimeMs);
      files.push({
        relativePath,
        area: artifactArea(relativePath),
        bytes: details.size,
        mtimeMs: details.mtimeMs,
        ageMs,
        likelyStale: ageMs >= finiteNonNegative(staleAfterMs),
        disposition: "retain-until-authorized",
      });
    }
  }

  await visit(resolvedRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const byArea = Object.fromEntries(AREAS.map((area) => [area, { count: 0, bytes: 0 }]));
  for (const file of files) {
    byArea[file.area].count += 1;
    byArea[file.area].bytes += file.bytes;
  }

  return {
    rootDir: resolvedRoot,
    generatedAt: new Date(Number(nowMs)).toISOString(),
    readOnly: true,
    deletionPerformed: false,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    byArea,
    files,
    cleanup: {
      authorizationRequired: true,
      safeToDelete: [],
      manualReview: files.map((file) => ({
        relativePath: file.relativePath,
        reason: "没有活动 writer、进程归属和停止后封口的独立证明",
      })),
      suggestedSteps: [
        "重新采集服务 lock、active/desired 和目标账号进程快照",
        "确认目标临时文件不属于当前 writer 且停止后保持静止",
        "为明确目标生成可恢复备份或隔离目录清单",
        "获得本次清理的明确授权后再执行逐文件操作",
      ],
    },
  };
}

export async function measureRuntimeResources({
  durationMs = 100,
  resolutionMs = 10,
  queueLength = 0,
  artifactBuildDurationMs = 0,
  bufferBytes = 0,
} = {}) {
  const histogram = monitorEventLoopDelay({ resolution: Math.max(1, Math.floor(resolutionMs)) });
  const startedAt = performance.now();
  histogram.enable();
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs)));
  histogram.disable();
  const memory = process.memoryUsage();
  const toMilliseconds = (value) => Number.isFinite(value) ? value / 1e6 : 0;
  return {
    sampleDurationMs: performance.now() - startedAt,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    eventLoopDelayMs: {
      min: toMilliseconds(histogram.min),
      p50: toMilliseconds(histogram.percentile(50)),
      p95: toMilliseconds(histogram.percentile(95)),
      max: toMilliseconds(histogram.max),
    },
    queueLength: finiteNonNegative(queueLength),
    artifactBuildDurationMs: finiteNonNegative(artifactBuildDurationMs),
    bufferBytes: finiteNonNegative(bufferBytes),
  };
}

function argumentValue(name) {
  const prefix = `${name}=`;
  const argument = process.argv.slice(2).find((item) => item.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : null;
}

async function main() {
  const runtimeDir = argumentValue("--runtime");
  if (!runtimeDir) {
    throw new Error("Task 6 dry-run requires an explicit --runtime=<path>; no default runtime path is used.");
  }
  const [comparison, tempDryRun, resources] = await Promise.all([
    Promise.resolve(buildOfflineRuntimeArtifactOptimizationComparison()),
    collectRuntimeTempDryRun(runtimeDir),
    measureRuntimeResources(),
  ]);
  process.stdout.write(`${JSON.stringify({ comparison, tempDryRun, resources }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  });
}
