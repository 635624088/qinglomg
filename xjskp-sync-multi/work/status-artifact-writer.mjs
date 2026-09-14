import fs from "node:fs";
import path from "node:path";

import {
  clearStagedArtifactFingerprint,
  rememberStagedArtifactFingerprint,
} from "./status-artifact-fingerprint.mjs";

const committedFingerprints = new Map();

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableRenameError(err) {
  return err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
}

export function writeStatusArtifacts(files, options = {}) {
  const fsModule = options.fsModule || fs;
  const maxRetries = Math.max(1, Math.floor(options.maxRetries ?? 5));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 50));
  const results = [];
  const fingerprintGroups = new Map();

  for (const file of files) {
    const fingerprint = file.fingerprint ?? null;
    if (fingerprint === null) continue;
    const group = fingerprintGroups.get(fingerprint) || {
      paths: [],
      completed: 0,
      allCommitted: true,
    };
    group.paths.push(path.resolve(String(file.path)));
    fingerprintGroups.set(fingerprint, group);
  }

  const recordFingerprintOutcome = (fingerprint, status) => {
    if (fingerprint === null) return;
    const group = fingerprintGroups.get(fingerprint);
    if (!group) return;
    group.completed += 1;
    if (status !== "committed") group.allCommitted = false;
  };

  for (const file of files) {
    const tmpPath = `${file.path}.tmp`;
    const fingerprint = file.fingerprint ?? null;
    const detailed = file.fingerprint !== undefined || fingerprint !== null;
    const targetKey = path.resolve(String(file.path));
    if (fingerprint !== null && committedFingerprints.get(targetKey) === fingerprint) {
      recordFingerprintOutcome(fingerprint, "committed");
      results.push({
        path: file.path,
        ok: true,
        ...(detailed ? { status: "committed", replaced: false } : {}),
        attempts: 0,
      });
      continue;
    }
    if (typeof fsModule.readFileSync === "function") {
      try {
        const existing = fsModule.readFileSync(file.path);
        const existingBuffer = Buffer.isBuffer(existing) ? existing : Buffer.from(String(existing));
        const contentBuffer = Buffer.isBuffer(file.content)
          ? file.content
          : Buffer.from(String(file.content));
        if (Buffer.compare(existingBuffer, contentBuffer) === 0) {
          recordFingerprintOutcome(fingerprint, "committed");
          results.push({
            path: file.path,
            ok: true,
            ...(detailed ? { status: "committed", replaced: false } : {}),
            attempts: 0,
          });
          continue;
        }
      } catch {}
    }
    let attempts = 0;
    let lastError = null;
    let pending = false;
    let stopped = null;
    try {
      rememberStagedArtifactFingerprint(tmpPath, fingerprint);
      fsModule.writeFileSync(tmpPath, file.content, "utf8");
      while (attempts < maxRetries) {
        attempts++;
        try {
          const renameResult = fsModule.renameSync(tmpPath, file.path);
          pending = renameResult?.status === "pending";
          stopped = ["stopped", "superseded"].includes(renameResult?.status)
            ? renameResult
            : null;
          lastError = null;
          break;
        } catch (err) {
          lastError = err;
          if (!isRetryableRenameError(err) || attempts >= maxRetries) {
            break;
          }
          sleepSync(retryDelayMs);
        }
      }
    } catch (err) {
      lastError = err;
    } finally {
      clearStagedArtifactFingerprint(tmpPath);
    }

    if (lastError) {
      recordFingerprintOutcome(fingerprint, "failed");
      results.push({
        path: file.path,
        ok: false,
        ...(detailed ? { status: "failed", replaced: false } : {}),
        attempts: Math.max(attempts, 1),
        errorCode: lastError.code || null,
        errorMessage: lastError.message,
      });
      continue;
    }

    if (stopped) {
      recordFingerprintOutcome(fingerprint, "superseded");
      results.push({
        path: file.path,
        ok: false,
        ...(detailed ? { status: "superseded", replaced: false } : {}),
        attempts: Math.max(attempts, 1),
        errorCode: "RUNTIME_ARTIFACT_STOPPED",
        errorMessage: stopped.reason || "stopped",
      });
      continue;
    }

    recordFingerprintOutcome(fingerprint, pending ? "pending" : "committed");
    results.push({
      path: file.path,
      ok: true,
      ...(detailed ? { status: pending ? "pending" : "committed", replaced: !pending } : {}),
      attempts: Math.max(attempts, 1),
    });
  }

  for (const [fingerprint, group] of fingerprintGroups) {
    if (group.allCommitted && group.completed === group.paths.length) {
      for (const targetKey of group.paths) committedFingerprints.set(targetKey, fingerprint);
    }
  }

  return results;
}
