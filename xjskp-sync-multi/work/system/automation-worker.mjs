import fs from "node:fs";
import path from "node:path";
import util from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { parseAutomationProgressLine } from "./automation-progress.mjs";
import { createLatestAtomicWriter } from "./latest-atomic-writer.mjs";
import { takeStagedArtifactFingerprint } from "../status-artifact-fingerprint.mjs";
import { summarizeArtifactSubmission } from "../runtime-artifact-completion.mjs";

applyWorkerEnv(workerData?.env || {});
const statusWriter = installAsyncStatusArtifactWriter(process.env);
installParentLogBridge();
const stopController = new AbortController();
parentPort?.on("message", (message) => {
  if (message?.type === "stop") {
    stopController.abort(message.reason || "user-stop");
  }
});

let exitCode = 1;
try {
  const automation = await import("../inspect-garden-dryrun.mjs");
  try {
    await automation.runAutomationSession({
      signal: stopController.signal,
      onTeamOrderStatus(status) {
        parentPort?.postMessage({
          type: "teamOrderStatus",
          profileId: workerData?.profileId,
          status,
        });
      },
    });
    exitCode = 0;
  } catch (err) {
    const classified = typeof automation.classifyAutomationError === "function"
      ? automation.classifyAutomationError(err)
      : {
        reason: "error",
        category: "runtime",
        message: err?.message || String(err),
        rawMessage: err?.message || String(err),
          exitCode: 1,
        };
    parentPort?.postMessage({
      type: "automationExit",
      classification: {
        reason: classified.reason,
        category: classified.category,
        message: classified.message,
        rawMessage: classified.rawMessage,
        exitCode: classified.exitCode,
      },
    });
    console.error(JSON.stringify({
      step: "error",
      reason: classified.reason,
      category: classified.category,
      message: classified.message,
      rawMessage: classified.rawMessage,
      stack: err?.stack?.split("\n").slice(0, 3),
    }, null, 2));
    exitCode = Number.isInteger(classified.exitCode) ? classified.exitCode : 1;
  }
} catch (err) {
  console.error(JSON.stringify({
    step: "workerBootstrapError",
    message: err?.message || String(err),
    stack: err?.stack?.split("\n").slice(0, 3),
  }, null, 2));
  exitCode = 1;
} finally {
  statusWriter.close("worker-exited");
  await statusWriter.flush();
  parentPort?.close();
  process.exitCode = exitCode;
}

function applyWorkerEnv(env) {
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  delete process.env.AUTO_PLANT_LOG_PATH;
  process.env.XJSKP_MANAGED_LOGGING = "1";
  process.env.XJSKP_ASYNC_STATUS_WRITER = "1";
}

function installParentLogBridge() {
  for (const method of ["log", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const text = `${util.format(...args)}\n`;
      try {
        postAutomationReadyMessages(text);
        postAutomationProgressMessages(text);
        parentPort?.postMessage({ type: "log", method, text });
      } catch {
        original(...args);
      }
    };
  }
}

function postAutomationProgressMessages(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const payload = parseAutomationProgressLine(line);
    if (payload) parentPort?.postMessage({ type: "automationProgress", ...payload });
  }
}

function postAutomationReadyMessages(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const payload = parseAutomationReadyLine(line);
    if (!payload) continue;
    statusWriter.waitForFirstComplete("garden").then((artifactCompletion) => {
      if (artifactCompletion.complete) {
        parentPort?.postMessage({ type: "automationReady", ...payload, artifactCompletion });
      } else {
        parentPort?.postMessage({
          type: "automationArtifactNotReady",
          ...artifactCompletion,
          readyPayload: payload,
        });
      }
    }).catch((error) => {
      parentPort?.postMessage({
        type: "automationArtifactNotReady",
        chain: "garden",
        status: "unknown",
        complete: false,
        reason: error?.message || String(error),
      });
    });
  }
}

function parseAutomationReadyLine(line) {
  const text = String(line || "").trim();
  if (!text || !text.startsWith("{")) return null;
  try {
    const payload = JSON.parse(text);
    return payload?.step === "automationReady" ? payload : null;
  } catch {
    return null;
  }
}

function installAsyncStatusArtifactWriter(env) {
  const targetPaths = [
    env.STATUS_JSON_PATH,
    env.STATUS_HTML_PATH,
    env.STATUS_MD_PATH,
    env.ORDER_STATUS_JSON_PATH,
  ].filter(Boolean).map((item) => path.resolve(item));
  const tmpToTarget = new Map(targetPaths.map((target) => [path.resolve(`${target}.tmp`), target]));
  const staged = new Map();
  let closed = false;
  let closeReason = null;
  const originalWriteFileSync = fs.writeFileSync.bind(fs);
  const originalRenameSync = fs.renameSync.bind(fs);
  const writer = createLatestAtomicWriter({
    onError(err) {
      try {
        parentPort?.postMessage({
          type: "log",
          method: "warn",
          text: `${JSON.stringify({
            step: "asyncStatusWriteError",
            path: err.path,
            attempts: err.attempts,
            code: err.code,
            message: err.message,
          })}\n`,
        });
      } catch {}
    },
  });

  fs.writeFileSync = (filePath, data, options) => {
    const normalized = path.resolve(String(filePath));
    if (tmpToTarget.has(normalized)) {
      staged.set(normalized, {
        content: Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data), getEncoding(options)),
        fingerprint: takeStagedArtifactFingerprint(normalized),
      });
      return;
    }
    return originalWriteFileSync(filePath, data, options);
  };

  fs.renameSync = (from, to) => {
    const normalizedFrom = path.resolve(String(from));
    const target = tmpToTarget.get(normalizedFrom);
    if (target && path.resolve(String(to)) === target && staged.has(normalizedFrom)) {
      const stagedArtifact = staged.get(normalizedFrom);
      staged.delete(normalizedFrom);
      if (closed) return { status: "stopped", reason: closeReason || "worker-exited" };
      writer.enqueue(target, stagedArtifact.content, { fingerprint: stagedArtifact.fingerprint });
      return { status: "pending" };
    }
    return originalRenameSync(from, to);
  };

  return {
    close(reason = "worker-exited") {
      closed = true;
      closeReason = String(reason || "worker-exited");
    },
    async waitForFirstComplete(chain) {
      const results = await flushWriter();
      return summarizeArtifactSubmission(chain, results, {
        requiredTargets: targetPaths.filter((target) => artifactChainForTarget(target) === chain),
      });
    },
    async flush() {
      return await flushWriter();
    },
  };

  async function flushWriter() {
    const results = await writer.flush();
    for (const chain of ["garden", "order"]) {
      const chainResults = results.filter((result) => artifactChainForTarget(result.path) === chain);
      if (!chainResults.length) continue;
      parentPort?.postMessage({
        type: "artifactCompletion",
        ...summarizeArtifactSubmission(chain, chainResults, {
          requiredTargets: targetPaths.filter((target) => artifactChainForTarget(target) === chain),
        }),
      });
    }
    return results;
  }
}

function artifactChainForTarget(target) {
  return path.basename(target) === "order-status.json" ? "order" : "garden";
}

function getEncoding(options) {
  if (typeof options === "string") return options;
  if (options?.encoding) return options.encoding;
  return "utf8";
}
