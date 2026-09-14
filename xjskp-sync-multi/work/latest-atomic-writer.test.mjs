import test from "node:test";
import assert from "node:assert/strict";

import { createLatestAtomicWriter } from "./system/latest-atomic-writer.mjs";

test("latest atomic writer keeps at most one current and one latest pending write", async () => {
  let releaseFirstRename;
  let signalFirstRename;
  const firstRenameStarted = new Promise((resolve) => { signalFirstRename = resolve; });
  const staged = new Map();
  const completed = [];
  let renameCalls = 0;
  const fs = {
    async mkdir() {},
    async writeFile(filePath, content) {
      staged.set(filePath, Buffer.from(content).toString("utf8"));
    },
    async rename(from, to) {
      renameCalls += 1;
      if (renameCalls === 1) {
        signalFirstRename();
        await new Promise((resolve) => { releaseFirstRename = resolve; });
      }
      completed.push({ to, content: staged.get(from) });
      staged.delete(from);
    },
    async rm(filePath) {
      staged.delete(filePath);
    },
  };
  const writer = createLatestAtomicWriter({ fs, now: () => 1, random: () => 0.5 });

  writer.enqueue("C:\\runtime\\garden-status.json", "A");
  await firstRenameStarted;
  writer.enqueue("C:\\runtime\\garden-status.json", "B");
  writer.enqueue("C:\\runtime\\garden-status.json", "C");
  releaseFirstRename();
  await writer.flush();

  assert.equal(completed.length, 2);
  assert.deepEqual(completed.map((item) => item.content), ["A", "C"]);
});

test("latest atomic writer retries transient rename failures", async () => {
  const staged = new Set();
  const waits = [];
  let renameCalls = 0;
  const fs = {
    async mkdir() {},
    async writeFile(filePath) { staged.add(filePath); },
    async rename(from) {
      renameCalls += 1;
      if (renameCalls < 3) {
        const error = new Error("busy");
        error.code = "EPERM";
        throw error;
      }
      staged.delete(from);
    },
    async rm(filePath) { staged.delete(filePath); },
  };
  const writer = createLatestAtomicWriter({
    fs,
    retryDelaysMs: [0, 5, 10],
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  writer.enqueue("C:\\runtime\\garden-status.json", "latest");
  await writer.flush();

  assert.equal(renameCalls, 3);
  assert.deepEqual(waits, [5, 10]);
  assert.equal(staged.size, 0);
});

test("latest atomic writer reports one terminal error and removes its temp file", async () => {
  const staged = new Set();
  const errors = [];
  let renameCalls = 0;
  const fs = {
    async mkdir() {},
    async writeFile(filePath) { staged.add(filePath); },
    async rename() {
      renameCalls += 1;
      const error = new Error("locked");
      error.code = "EACCES";
      throw error;
    },
    async rm(filePath) { staged.delete(filePath); },
  };
  const writer = createLatestAtomicWriter({
    fs,
    retryDelaysMs: [0, 1],
    wait: async () => {},
    onError: (event) => errors.push(event),
  });

  writer.enqueue("C:\\runtime\\garden-status.json", "latest");
  await writer.flush();

  assert.equal(renameCalls, 2);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, "EACCES");
  assert.equal(staged.size, 0);
});

test("latest atomic writer returns committed and superseded results per target", async () => {
  let releaseFirstRename;
  let signalFirstRename;
  const firstRenameStarted = new Promise((resolve) => { signalFirstRename = resolve; });
  const staged = new Map();
  const completed = [];
  let renameCalls = 0;
  const fs = {
    async mkdir() {},
    async readFile() {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    async writeFile(filePath, content) {
      staged.set(filePath, Buffer.from(content).toString("utf8"));
    },
    async rename(from, to) {
      renameCalls += 1;
      if (renameCalls === 1) {
        signalFirstRename();
        await new Promise((resolve) => { releaseFirstRename = resolve; });
      }
      completed.push({ to, content: staged.get(from) });
      staged.delete(from);
    },
    async rm(filePath) {
      staged.delete(filePath);
    },
  };
  const writer = createLatestAtomicWriter({ fs, now: () => 1, random: () => 0.5 });

  const first = writer.enqueue("C:\\runtime\\garden-status.json", "A");
  await firstRenameStarted;
  const superseded = writer.enqueue("C:\\runtime\\garden-status.json", "B");
  const latest = writer.enqueue("C:\\runtime\\garden-status.json", "C");
  releaseFirstRename();

  await writer.flush();
  assert.deepEqual(await Promise.all([first, superseded, latest]), [
    { path: "C:\\runtime\\garden-status.json", status: "committed", attempts: 1, replaced: true },
    {
      path: "C:\\runtime\\garden-status.json",
      status: "superseded",
      attempts: 0,
      replaced: false,
      replacedBy: "C",
    },
    { path: "C:\\runtime\\garden-status.json", status: "committed", attempts: 1, replaced: true },
  ]);
  assert.deepEqual(completed.map((item) => item.content), ["A", "C"]);
});

test("latest atomic writer reports unknown commit state without pretending success", async () => {
  const staged = new Set();
  const errors = [];
  const fs = {
    async mkdir() {},
    async readFile() {
      const error = new Error("missing");
      error.code = "ENOENT";
      throw error;
    },
    async writeFile(filePath) { staged.add(filePath); },
    async rename() {
      const error = new Error("rename result is unknown");
      error.commitStatus = "unknown";
      throw error;
    },
    async rm(filePath) { staged.delete(filePath); },
  };
  const writer = createLatestAtomicWriter({
    fs,
    retryDelaysMs: [0, 1],
    wait: async () => {},
    onError: (event) => errors.push(event),
  });

  const resultPromise = writer.enqueue("C:\\runtime\\garden-status.json", "latest");
  await writer.flush();

  assert.deepEqual(await resultPromise, {
    path: "C:\\runtime\\garden-status.json",
    status: "unknown",
    attempts: 1,
    replaced: false,
  });
  assert.equal(errors[0].status, "unknown");
  assert.equal(staged.size, 0);
});

test("latest atomic writer commits an unchanged target without replacing it", async () => {
  let renameCalls = 0;
  const fs = {
    async mkdir() {},
    async readFile() { return Buffer.from("same"); },
    async writeFile() { throw new Error("must not stage unchanged content"); },
    async rename() { renameCalls += 1; },
    async rm() {},
  };
  const writer = createLatestAtomicWriter({ fs });

  const resultPromise = writer.enqueue("C:\\runtime\\garden-status.json", "same");
  await writer.flush();

  assert.deepEqual(await resultPromise, {
    path: "C:\\runtime\\garden-status.json",
    status: "committed",
    attempts: 0,
    replaced: false,
  });
  assert.equal(renameCalls, 0);
});
