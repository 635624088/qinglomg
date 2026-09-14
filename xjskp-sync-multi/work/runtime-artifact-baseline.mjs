const DEFAULT_ARTIFACT_TARGETS = Object.freeze([
  "garden-status.json",
  "garden-status.html",
  "garden-status.md",
]);

function finiteNonNegative(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function contentBytes(content) {
  if (Buffer.isBuffer(content)) return content.byteLength;
  return Buffer.byteLength(String(content ?? ""), "utf8");
}

function clone(value) {
  return structuredClone(value);
}

export function createRuntimeArtifactBaseline({ profileId = "offline-fixture" } = {}) {
  const metrics = {
    profileId: String(profileId),
    artifact: {
      buildCount: 0,
      logicalWriteBytes: 0,
      actualReplaceCount: 0,
      buildDurationsMs: [],
      maxQueueLength: 0,
      builds: [],
    },
    fullStatusRead: {
      requestCount: 0,
      fileCount: 0,
      parseCount: 0,
      responseBytes: 0,
      renderCount: 0,
      byTrigger: {},
      reads: [],
    },
    game: {
      requests: [],
      retryCount: 0,
      failures: [],
    },
    logs: {
      entries: [],
      logicalBytes: 0,
    },
    lifecycle: {
      events: [],
      latenciesMs: [],
      lostCount: 0,
      duplicateCount: 0,
    },
  };

  return Object.freeze({
    recordArtifactBuild({
      atMs = null,
      reason = "unknown",
      files = [],
      logicalWriteBytes = null,
      actualReplaceCount = null,
      buildDurationMs = 0,
      queueLength = 0,
    } = {}) {
      if (!Array.isArray(files)) throw new TypeError("artifact files must be an array");
      const bytes = logicalWriteBytes == null
        ? files.reduce((sum, file) => sum + contentBytes(file?.content), 0)
        : finiteNonNegative(logicalWriteBytes);
      const replacements = actualReplaceCount == null
        ? files.filter((file) => file?.committed !== false).length
        : finiteNonNegative(actualReplaceCount);
      const duration = finiteNonNegative(buildDurationMs);
      const queue = finiteNonNegative(queueLength);
      metrics.artifact.buildCount += 1;
      metrics.artifact.logicalWriteBytes += bytes;
      metrics.artifact.actualReplaceCount += replacements;
      metrics.artifact.buildDurationsMs.push(duration);
      metrics.artifact.maxQueueLength = Math.max(metrics.artifact.maxQueueLength, queue);
      metrics.artifact.builds.push({
        atMs,
        reason: String(reason),
        targetCount: files.length,
        logicalWriteBytes: bytes,
        actualReplaceCount: replacements,
        buildDurationMs: duration,
        queueLength: queue,
      });
    },

    recordFullStatusRead({
      atMs = null,
      trigger = "unknown",
      files = [],
      parsedFiles = files.length,
      responseBytes = 0,
      rendered = true,
    } = {}) {
      if (!Array.isArray(files)) throw new TypeError("status files must be an array");
      const triggerName = String(trigger);
      metrics.fullStatusRead.requestCount += 1;
      metrics.fullStatusRead.fileCount += files.length;
      metrics.fullStatusRead.parseCount += finiteNonNegative(parsedFiles);
      metrics.fullStatusRead.responseBytes += finiteNonNegative(responseBytes);
      if (rendered) metrics.fullStatusRead.renderCount += 1;
      metrics.fullStatusRead.byTrigger[triggerName] =
        (metrics.fullStatusRead.byTrigger[triggerName] || 0) + 1;
      metrics.fullStatusRead.reads.push({
        atMs,
        trigger: triggerName,
        fileCount: files.length,
        parsedFiles: finiteNonNegative(parsedFiles),
        responseBytes: finiteNonNegative(responseBytes),
        rendered: Boolean(rendered),
      });
    },

    recordGameRequest({
      atMs = null,
      iface,
      args = {},
      trigger = "unknown",
      attempt = 1,
      outcome = "success",
      errorCategory = null,
    } = {}) {
      if (!iface) throw new TypeError("game request iface is required");
      const attemptNumber = Math.max(1, Math.floor(Number(attempt) || 1));
      const request = {
        atMs,
        iface: String(iface),
        args: clone(args),
        trigger: String(trigger),
        attempt: attemptNumber,
        outcome: String(outcome),
        errorCategory: errorCategory == null ? null : String(errorCategory),
      };
      metrics.game.requests.push(request);
      metrics.game.retryCount += attemptNumber - 1;
      if (request.outcome !== "success") metrics.game.failures.push(request);
    },

    recordSystemLog({
      atMs = null,
      level = "info",
      step = null,
      message = "",
      raw = null,
    } = {}) {
      const entry = {
        atMs,
        level: String(level),
        step: step == null ? null : String(step),
        message: String(message),
      };
      metrics.logs.entries.push(entry);
      metrics.logs.logicalBytes += contentBytes(raw ?? JSON.stringify(entry));
    },

    recordLifecycleEvent({
      event,
      emittedAtMs = null,
      domVisibleAtMs = null,
      source = "offline-fixture",
      duplicate = false,
      lost = false,
      fullReadCount = 0,
    } = {}) {
      if (!event) throw new TypeError("lifecycle event is required");
      const latency = Number(domVisibleAtMs) - Number(emittedAtMs);
      const record = {
        event: String(event),
        emittedAtMs,
        domVisibleAtMs,
        latencyMs: Number.isFinite(latency) ? latency : null,
        source: String(source),
        duplicate: Boolean(duplicate),
        lost: Boolean(lost),
        fullReadCount: finiteNonNegative(fullReadCount),
      };
      metrics.lifecycle.events.push(record);
      if (record.latencyMs != null) metrics.lifecycle.latenciesMs.push(record.latencyMs);
      if (record.duplicate) metrics.lifecycle.duplicateCount += 1;
      if (record.lost) metrics.lifecycle.lostCount += 1;
    },

    snapshot() {
      return clone(metrics);
    },
  });
}

export function runOfflineRuntimeArtifactBaseline({
  profileId = "offline-fixture",
  durationMs = 15_000,
  statusRefreshIntervalMs = 5_000,
  artifactTargets = DEFAULT_ARTIFACT_TARGETS,
  fullStatusFiles = ["garden-status.json", "order-status.json"],
  artifactContent = (target, atMs) => `${target}:${atMs}`,
} = {}) {
  const recorder = createRuntimeArtifactBaseline({ profileId });
  const duration = finiteNonNegative(durationMs);
  const interval = Math.max(1, finiteNonNegative(statusRefreshIntervalMs, 5_000));
  for (let atMs = 0; atMs < duration; atMs += interval) {
    recorder.recordArtifactBuild({
      atMs,
      reason: "fixed-status-projection",
      files: artifactTargets.map((path) => ({
        path,
        content: artifactContent(path, atMs),
      })),
      buildDurationMs: 2,
      queueLength: 1,
    });
  }
  recorder.recordFullStatusRead({
    atMs: 0,
    trigger: "first-open",
    files: fullStatusFiles,
    parsedFiles: fullStatusFiles.length,
    responseBytes: 256,
  });
  recorder.recordLifecycleEvent({
    event: "first-complete-persist",
    emittedAtMs: 100,
    domVisibleAtMs: 140,
    source: "offline-fixture",
    fullReadCount: 1,
  });
  return recorder.snapshot();
}

export { DEFAULT_ARTIFACT_TARGETS };
