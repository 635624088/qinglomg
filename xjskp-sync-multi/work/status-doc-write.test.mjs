import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeStatusArtifacts } from "./status-artifact-writer.mjs";

test("writeStatusArtifacts retries transient EPERM rename failures and succeeds", () => {
  const files = new Map();
  let renameAttempts = 0;
  const fsModule = {
    mkdirSync() {},
    writeFileSync(targetPath, content) {
      files.set(targetPath, content);
    },
    renameSync(fromPath, toPath) {
      renameAttempts++;
      if (renameAttempts < 3) {
        const err = new Error(`EPERM: operation not permitted, rename '${fromPath}' -> '${toPath}'`);
        err.code = "EPERM";
        throw err;
      }
      files.set(toPath, files.get(fromPath));
      files.delete(fromPath);
    },
  };

  const results = writeStatusArtifacts([
    { path: "outputs/garden-status.html", content: "<html></html>" },
  ], {
    fsModule,
    maxRetries: 3,
    retryDelayMs: 0,
  });

  assert.equal(renameAttempts, 3);
  assert.deepEqual(results, [
    {
      path: "outputs/garden-status.html",
      ok: true,
      attempts: 3,
    },
  ]);
  assert.equal(files.get("outputs/garden-status.html"), "<html></html>");
});

test("writeStatusArtifacts keeps later status files updating when one target stays locked", () => {
  const files = new Map();
  const fsModule = {
    mkdirSync() {},
    writeFileSync(targetPath, content) {
      files.set(targetPath, content);
    },
    renameSync(fromPath, toPath) {
      if (toPath.endsWith("garden-status.html")) {
        const err = new Error(`EPERM: operation not permitted, rename '${fromPath}' -> '${toPath}'`);
        err.code = "EPERM";
        throw err;
      }
      files.set(toPath, files.get(fromPath));
      files.delete(fromPath);
    },
  };

  const results = writeStatusArtifacts([
    { path: "outputs/garden-status.html", content: "<html></html>" },
    { path: "outputs/garden-status.md", content: "# ok" },
    { path: "outputs/garden-status.json", content: "{}\n" },
  ], {
    fsModule,
    maxRetries: 2,
    retryDelayMs: 0,
  });

  assert.equal(results[0].ok, false);
  assert.equal(results[0].path, "outputs/garden-status.html");
  assert.equal(results[0].attempts, 2);
  assert.equal(results[0].errorCode, "EPERM");
  assert.equal(results[1].ok, true);
  assert.equal(results[2].ok, true);
  assert.equal(files.get("outputs/garden-status.md"), "# ok");
  assert.equal(files.get("outputs/garden-status.json"), "{}\n");
});

test("writeStatusArtifacts does not retry non-transient rename failures", () => {
  let renameAttempts = 0;
  const fsModule = {
    mkdirSync() {},
    writeFileSync() {},
    renameSync() {
      renameAttempts++;
      const err = new Error("EINVAL: invalid argument");
      err.code = "EINVAL";
      throw err;
    },
  };

  const results = writeStatusArtifacts([
    { path: "outputs/garden-status.json", content: "{}\n" },
  ], {
    fsModule,
    maxRetries: 5,
    retryDelayMs: 0,
  });

  assert.equal(renameAttempts, 1);
  assert.deepEqual(results, [{
    path: "outputs/garden-status.json",
    ok: false,
    attempts: 1,
    errorCode: "EINVAL",
    errorMessage: "EINVAL: invalid argument",
  }]);
});

test("writeStatusArtifacts commits unchanged content without staging or replacing", () => {
  let writeCalls = 0;
  let renameCalls = 0;
  const fsModule = {
    readFileSync() {
      return Buffer.from("same\n");
    },
    writeFileSync() {
      writeCalls += 1;
    },
    renameSync() {
      renameCalls += 1;
    },
  };

  const results = writeStatusArtifacts([
    { path: "outputs/garden-status.json", content: "same\n", fingerprint: "business-same" },
  ], { fsModule });

  assert.deepEqual(results, [{
    path: "outputs/garden-status.json",
    ok: true,
    status: "committed",
    attempts: 0,
    replaced: false,
  }]);
  assert.equal(writeCalls, 0);
  assert.equal(renameCalls, 0);
});

test("writeStatusArtifacts does not replace an unchanged committed fingerprint", () => {
  const files = new Map();
  let renameAttempts = 0;
  const fsModule = {
    mkdirSync() {},
    writeFileSync(targetPath, content) {
      files.set(targetPath, content);
    },
    renameSync(fromPath, toPath) {
      renameAttempts++;
      files.set(toPath, files.get(fromPath));
      files.delete(fromPath);
    },
  };
  const artifact = { path: "outputs/garden-status.json", content: "{\"updatedAt\":\"now\"}\n", fingerprint: "business-v1" };

  const first = writeStatusArtifacts([artifact], { fsModule, retryDelayMs: 0 });
  const second = writeStatusArtifacts([artifact], { fsModule, retryDelayMs: 0 });

  assert.equal(renameAttempts, 1);
  assert.deepEqual(first, [{
    path: "outputs/garden-status.json",
    ok: true,
    status: "committed",
    attempts: 1,
    replaced: true,
  }]);
  assert.deepEqual(second, [{
    path: "outputs/garden-status.json",
    ok: true,
    status: "committed",
    attempts: 0,
    replaced: false,
  }]);
});

test("writeStatusArtifacts does not advance a garden fingerprint after a partial target failure", () => {
  const files = new Map();
  let failHtmlOnce = true;
  let renameAttempts = 0;
  const fsModule = {
    writeFileSync(targetPath, content) {
      files.set(targetPath, content);
    },
    renameSync(fromPath, toPath) {
      renameAttempts += 1;
      if (toPath.endsWith("garden-status.html") && failHtmlOnce) {
        failHtmlOnce = false;
        const error = new Error("locked");
        error.code = "EPERM";
        throw error;
      }
      files.set(toPath, files.get(fromPath));
      files.delete(fromPath);
    },
  };
  const artifactFiles = [
    { path: "outputs/task2-garden-status.html", content: "<html>v1</html>", fingerprint: "garden-v1" },
    { path: "outputs/task2-garden-status.md", content: "# v1", fingerprint: "garden-v1" },
    { path: "outputs/task2-garden-status.json", content: "{\"business\":1}\n", fingerprint: "garden-v1" },
  ];

  const first = writeStatusArtifacts(artifactFiles, { fsModule, maxRetries: 1, retryDelayMs: 0 });
  const second = writeStatusArtifacts(artifactFiles, { fsModule, maxRetries: 1, retryDelayMs: 0 });

  assert.equal(first[0].ok, false);
  assert.equal(first[1].status, "committed");
  assert.equal(first[2].status, "committed");
  assert.deepEqual(second.map((result) => result.status), ["committed", "committed", "committed"]);
  assert.equal(renameAttempts, 6);
});

test("writeStatusArtifacts keeps hash, mtime, rename and logical writes stable for an unchanged snapshot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "status-artifact-fingerprint-"));
  const target = path.join(dir, "garden-status.json");
  let renameCount = 0;
  let logicalWriteCount = 0;
  const fsModule = {
    ...fs,
    writeFileSync(targetPath, content, options) {
      logicalWriteCount++;
      return fs.writeFileSync(targetPath, content, options);
    },
    renameSync(fromPath, toPath) {
      renameCount++;
      return fs.renameSync(fromPath, toPath);
    },
  };
  const write = (content) => writeStatusArtifacts([{
    path: target,
    content,
    fingerprint: "garden-business-v1",
  }], { fsModule, retryDelayMs: 0 });

  try {
    write("{\"updatedAt\":\"10:00\",\"count\":1}\n");
    const before = fs.statSync(target);
    const beforeHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    const second = write("{\"updatedAt\":\"10:01\",\"count\":1}\n");
    const after = fs.statSync(target);
    const afterHash = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");

    assert.deepEqual(second, [{
      path: target,
      ok: true,
      status: "committed",
      attempts: 0,
      replaced: false,
    }]);
    assert.equal(afterHash, beforeHash);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(renameCount, 1);
    assert.equal(logicalWriteCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("writeStatusArtifacts does not treat a stopped async rename as committed", () => {
  const files = new Map();
  const fsModule = {
    writeFileSync(targetPath, content) {
      files.set(targetPath, content);
    },
    renameSync() {
      return { status: "stopped", reason: "user-stopped" };
    },
  };

  const [result] = writeStatusArtifacts([
    { path: "outputs/stopped-garden-status.json", content: "late\n", fingerprint: "late-v1" },
  ], { fsModule, retryDelayMs: 0 });

  assert.deepEqual(result, {
    path: "outputs/stopped-garden-status.json",
    ok: false,
    status: "superseded",
    attempts: 1,
    replaced: false,
    errorCode: "RUNTIME_ARTIFACT_STOPPED",
    errorMessage: "user-stopped",
  });
});
