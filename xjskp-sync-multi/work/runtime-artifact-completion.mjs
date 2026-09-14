import path from "node:path";
import * as defaultFs from "node:fs/promises";

const COMMITTED_STATUS = "committed";

export function summarizeArtifactSubmission(chain, results = [], options = {}) {
  const requiredTargets = normalizeTargets(options.requiredTargets || []);
  const byTarget = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!result?.path) continue;
    const target = path.resolve(String(result.path));
    byTarget.set(target, result);
  }
  const missingTargets = requiredTargets
    .filter((target) => !byTarget.has(target))
    .map(displayTarget);
  const failedTargets = requiredTargets
    .filter((target) => byTarget.has(target) && byTarget.get(target)?.status !== COMMITTED_STATUS)
    .map(displayTarget);
  const complete = requiredTargets.length > 0
    && requiredTargets.every((target) => byTarget.get(target)?.status === COMMITTED_STATUS);
  return {
    chain: String(chain || "unknown"),
    status: complete ? "complete" : "incomplete",
    complete,
    requiredTargets: requiredTargets.map(displayTarget),
    missingTargets,
    failedTargets,
    usedExistingFileAsSuccess: false,
    results: requiredTargets
      .filter((target) => byTarget.has(target))
      .map((target) => ({ ...byTarget.get(target), path: displayTarget(target) })),
  };
}

export function createRuntimeArtifactCompletion(options = {}) {
  const requiredTargets = Object.fromEntries(
    Object.entries(options.requiredTargets || {}).map(([chain, targets]) => [
      chain,
      normalizeTargets(targets),
    ]),
  );
  const chains = new Map(Object.keys(requiredTargets).map((chain) => [
    chain,
    {
      chain,
      status: "pending",
      complete: false,
      requiredTargets: requiredTargets[chain].map(displayTarget),
      missingTargets: requiredTargets[chain].map(displayTarget),
      failedTargets: [],
      usedExistingFileAsSuccess: false,
      results: [],
    },
  ]));
  let closed = false;
  let closeReason = null;

  function observe(chain, results) {
    const name = String(chain || "unknown");
    if (closed) {
      return {
        chain: name,
        status: "superseded",
        complete: false,
        reason: closeReason || "stopped",
      };
    }
    const summary = summarizeArtifactSubmission(name, results, {
      requiredTargets: requiredTargets[name] || [],
    });
    chains.set(name, summary);
    options.onChange?.(summary);
    return summary;
  }

  function snapshot() {
    return Object.fromEntries([...chains.entries()].map(([chain, summary]) => [
      chain,
      structuredClone(summary),
    ]));
  }

  function close(reason = "stopped") {
    closed = true;
    closeReason = String(reason || "stopped");
    return { closed: true, reason: closeReason, snapshot: snapshot() };
  }

  return {
    observe,
    snapshot,
    close,
    isClosed: () => closed,
    isOpen: () => !closed,
  };
}

export async function cleanupRuntimeArtifactTemps(statusDir, options = {}) {
  const fs = options.fs || defaultFs;
  const directory = path.resolve(String(statusDir || ""));
  if (!statusDir) return [];
  const targetNames = [
    "garden-status.json",
    "garden-status.html",
    "garden-status.md",
    "order-status.json",
  ];
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const temporaryNames = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => targetNames.some((target) => (
      name === `${target}.tmp`
      || (name.startsWith(`${target}.`) && name.endsWith(".tmp"))
    )));
  await Promise.all(temporaryNames.map((name) => fs.rm(path.join(directory, name), { force: true })));
  return temporaryNames;
}

function normalizeTargets(targets) {
  return [...new Set((Array.isArray(targets) ? targets : []).map((target) => path.resolve(String(target))))];
}

function displayTarget(target) {
  return path.basename(target);
}
