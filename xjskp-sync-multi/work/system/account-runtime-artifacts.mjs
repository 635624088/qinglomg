import * as defaultFs from "node:fs/promises";
import path from "node:path";

export const ACCOUNT_RUNTIME_ARTIFACT_REGISTRY = Object.freeze([
  Object.freeze({
    kind: "profile",
    stores: Object.freeze([{ type: "profile-json-dir", relativePath: "accounts" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/profile-store.mjs", pattern: "path\\.join\\(accountsDir" }),
    ]),
  }),
  Object.freeze({
    kind: "runtime-settings",
    stores: Object.freeze([{ type: "filename-json-dir", relativePath: "settings" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/runtime-settings-store.mjs", pattern: 'runtimeDir, "settings"' }),
    ]),
  }),
  Object.freeze({
    kind: "desired-run",
    stores: Object.freeze([{ type: "record-json-dir", relativePath: "system/desired-runs" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/automation-recovery.mjs", pattern: 'runtimeDir, "system", "desired-runs"' }),
    ]),
  }),
  Object.freeze({
    kind: "experience-guard",
    stores: Object.freeze([{ type: "record-json-dir", relativePath: "system/experience-guards" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./experience-guard-state.mjs", pattern: '"system",\\s*"experience-guards"' }),
    ]),
  }),
  Object.freeze({
    kind: "waterwheel-bucket",
    stores: Object.freeze([{ type: "record-json-dir", relativePath: "system/waterwheel-buckets" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./waterwheel-bucket-state.mjs", pattern: '"system",\\s*"waterwheel-buckets"' }),
    ]),
  }),
  Object.freeze({
    kind: "active-task",
    stores: Object.freeze([
      { type: "record-json-dir", relativePath: "system/active-tasks" },
      { type: "record-json-file", relativePath: "system/active-task.json" },
    ]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/runtime-lock.mjs", pattern: 'ACTIVE_TASKS_DIR = "active-tasks"' }),
      Object.freeze({ file: "./system/runtime-lock.mjs", pattern: 'ACTIVE_TASK_FILE = "active-task\\.json"' }),
    ]),
  }),
  Object.freeze({
    kind: "last-exit",
    stores: Object.freeze([
      { type: "record-json-dir", relativePath: "system/last-task-exits" },
      { type: "record-json-file", relativePath: "system/last-task-exit.json" },
    ]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/runtime-lock.mjs", pattern: 'LAST_TASK_EXITS_DIR = "last-task-exits"' }),
      Object.freeze({ file: "./system/runtime-lock.mjs", pattern: 'LAST_TASK_EXIT_FILE = "last-task-exit\\.json"' }),
    ]),
  }),
  Object.freeze({
    kind: "status",
    stores: Object.freeze([{ type: "profile-dir", relativePath: "status" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/process-manager.mjs", pattern: 'runtimeDir, "status", profileId' }),
    ]),
  }),
  Object.freeze({
    kind: "logs",
    stores: Object.freeze([{ type: "profile-dir", relativePath: "logs" }]),
    evidence: Object.freeze([
      Object.freeze({ file: "./system/process-manager.mjs", pattern: 'runtimeDir, "logs", profileId' }),
    ]),
  }),
]);

export async function inventoryAccountRuntimeTargets(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || path.join(process.cwd(), "runtime"));
  const fs = options.fs || defaultFs;
  const targets = new Map();
  const errors = [];

  const addError = (code, filePath, message, details = {}) => {
    errors.push({
      code,
      path: path.relative(runtimeDir, filePath).replaceAll("\\", "/"),
      message,
      ...details,
    });
  };

  const register = (rawProfileId, artifact, { profilePresent = false } = {}) => {
    const rawId = String(rawProfileId || "").trim();
    const profileId = canonicalizeProfileId(rawId);
    if (!profileId) {
      addError(
        "ACCOUNT_RUNTIME_ARTIFACT_UNOWNED",
        artifact.path,
        "Artifact does not contain a usable profileId",
        { kind: artifact.kind },
      );
      return;
    }
    let target = targets.get(profileId);
    if (!target) {
      target = {
        profileId,
        profilePresent: false,
        rawIds: new Set(),
        artifacts: [],
      };
      targets.set(profileId, target);
    }
    target.profilePresent ||= profilePresent;
    target.rawIds.add(rawId);
    target.artifacts.push({
      kind: artifact.kind,
      path: artifact.path,
      relativePath: path.relative(runtimeDir, artifact.path).replaceAll("\\", "/"),
      rawProfileId: rawId,
      source: artifact.source,
    });
  };

  for (const entry of ACCOUNT_RUNTIME_ARTIFACT_REGISTRY) {
    for (const store of entry.stores) {
      const storePath = path.join(runtimeDir, ...store.relativePath.split("/"));
      if (store.type === "profile-json-dir") {
        for (const file of await listJsonFiles(fs, storePath)) {
          const filePath = path.join(storePath, file.name);
          const fileProfileId = file.name.slice(0, -5);
          const record = await readJsonSafe(fs, filePath);
          if (!record.ok) {
            register(fileProfileId, { kind: entry.kind, path: filePath, source: "filename" }, { profilePresent: true });
            addError("ACCOUNT_RUNTIME_ARTIFACT_INVALID_JSON", filePath, "Profile record is not valid JSON", { kind: entry.kind });
            continue;
          }
          const recordProfileId = String(record.value?.id || "").trim();
          register(recordProfileId || fileProfileId, {
            kind: entry.kind,
            path: filePath,
            source: recordProfileId ? "record.id" : "filename",
          }, { profilePresent: true });
          if (recordProfileId && recordProfileId !== fileProfileId) {
            addError(
              "ACCOUNT_RUNTIME_ARTIFACT_OWNER_MISMATCH",
              filePath,
              "Profile filename and record id do not match",
              { kind: entry.kind, fileProfileId, recordProfileId },
            );
          }
        }
        continue;
      }

      if (store.type === "filename-json-dir") {
        for (const file of await listJsonFiles(fs, storePath)) {
          const filePath = path.join(storePath, file.name);
          register(file.name.slice(0, -5), { kind: entry.kind, path: filePath, source: "filename" });
        }
        continue;
      }

      if (store.type === "record-json-dir") {
        for (const file of await listJsonFiles(fs, storePath)) {
          await registerRecordFile({ fs, filePath: path.join(storePath, file.name), entry, register, addError });
        }
        continue;
      }

      if (store.type === "record-json-file") {
        if (await pathExists(fs, storePath)) {
          await registerRecordFile({ fs, filePath: storePath, entry, register, addError });
        }
        continue;
      }

      if (store.type === "profile-dir") {
        for (const directory of await listDirectories(fs, storePath)) {
          register(directory.name, {
            kind: entry.kind,
            path: path.join(storePath, directory.name),
            source: "directory-name",
          });
        }
      }
    }
  }

  const normalizedTargets = [...targets.values()]
    .map((target) => {
      const rawIds = [...target.rawIds].sort();
      return {
        profileId: target.profileId,
        profilePresent: target.profilePresent,
        rawIds,
        collision: rawIds.length > 1,
        artifacts: target.artifacts.sort(compareArtifacts),
      };
    })
    .sort((left, right) => left.profileId.localeCompare(right.profileId));
  const collisions = normalizedTargets.filter((target) => target.collision);
  return {
    version: 1,
    runtimeDir,
    writable: errors.length === 0 && collisions.length === 0,
    targets: normalizedTargets,
    errors: errors.sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)),
    collisions: collisions.map((target) => ({ profileId: target.profileId, rawIds: target.rawIds })),
  };
}

async function registerRecordFile({ fs, filePath, entry, register, addError }) {
  const record = await readJsonSafe(fs, filePath);
  const profileId = record.ok ? String(record.value?.profileId || "").trim() : "";
  if (!record.ok || !profileId) {
    addError(
      "ACCOUNT_RUNTIME_ARTIFACT_UNOWNED",
      filePath,
      "Runtime record is invalid or has no profileId",
      { kind: entry.kind },
    );
    return;
  }
  register(profileId, { kind: entry.kind, path: filePath, source: "record.profileId" });
}

function canonicalizeProfileId(value) {
  const slug = String(value || "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return slug || null;
}

async function readJsonSafe(fs, filePath) {
  try {
    return { ok: true, value: JSON.parse(await fs.readFile(filePath, "utf8")) };
  } catch (error) {
    return { ok: false, error };
  }
}

async function listJsonFiles(fs, directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function listDirectories(fs, directory) {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory());
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function pathExists(fs, filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function compareArtifacts(left, right) {
  return left.kind.localeCompare(right.kind) || left.relativePath.localeCompare(right.relativePath);
}
