import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

test("root command entrypoints redirect to the isolated sync-multi-next package unless portable", async () => {
  for (const file of [
    "start-system.cmd",
    "stop-system.cmd",
    "reset-auto-plant-secrets.cmd",
    "run-auto-plant.cmd",
    "run-auto-plant-once.cmd",
    "重置账号凭据.cmd",
  ]) {
    const content = await fs.readFile(path.join(rootDir, file), "utf8");
    assert.match(content, /PORTABLE-RUNTIME\.txt/i, file);
    assert.match(content, /release\\xjskp-sync-multi-next/i, file);
    assert.match(content, /:runLocal/i, file);
  }
});

test("Chinese root entrypoint redirects with its actual filename", async () => {
  const content = await fs.readFile(path.join(rootDir, "重置账号凭据.cmd"), "utf8");

  assert.match(content, /release\\xjskp-sync-multi-next\\%~nx0/i);
  assert.doesNotMatch(content, /\?{2,}\.cmd/i);
});

test("interactive system entrypoints expose an explicit no-pause automation mode", async () => {
  for (const file of ["start-system.cmd", "stop-system.cmd", "重置账号凭据.cmd"]) {
    const content = await fs.readFile(path.join(rootDir, file), "utf8");

    assert.match(content, /if defined XJSKP_NO_PAUSE exit \/b/i, file);
  }
});

test("root command entrypoints preserve redirected child exit codes", {
  skip: process.platform !== "win32",
}, async () => {
  for (const file of [
    "start-system.cmd",
    "stop-system.cmd",
    "reset-auto-plant-secrets.cmd",
    "run-auto-plant.cmd",
    "run-auto-plant-once.cmd",
    "重置账号凭据.cmd",
  ]) {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "xjskp-root-cmd-exit-"));
    try {
      const childDir = path.join(tempRoot, "release", "xjskp-sync-multi-next");
      await fs.mkdir(childDir, { recursive: true });
      await fs.copyFile(path.join(rootDir, file), path.join(tempRoot, file));
      await fs.writeFile(path.join(childDir, file), "@echo off\r\nexit /b 7\r\n", "utf8");

      const result = spawnSync("cmd.exe", ["/d", "/c", path.join(tempRoot, file)], {
        encoding: "utf8",
        env: { ...process.env, XJSKP_NO_PAUSE: "1" },
      });

      assert.equal(result.status, 7, `${file}: ${result.stderr || result.stdout}`);
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
});

test("package-system defaults to release and refuses non-release output", async () => {
  const content = await fs.readFile(path.join(rootDir, "work", "package-system.ps1"), "utf8");

  assert.match(content, /release\\xjskp-sync-multi-next/i);
  assert.match(content, /Refusing to write package outside release/i);
  assert.doesNotMatch(content, /dist\\xjskp-sync-multi/i);
});

test("stop-system can stop wrapper command processes and their relative-path children", async () => {
  const content = await fs.readFile(path.join(rootDir, "work", "stop-system.ps1"), "utf8");

  assert.match(content, /ParentProcessId/);
  assert.match(content, /run-auto-plant\.cmd/i);
  assert.match(content, /work\\run-auto-plant\.ps1/i);
});

test("standalone automation checks the persistent game-data sync barrier before credentials or Node startup", async () => {
  const powershell = await fs.readFile(path.join(rootDir, "work", "run-auto-plant.ps1"), "utf8");
  const nodeEntry = await fs.readFile(path.join(rootDir, "work", "inspect-garden-dryrun.mjs"), "utf8");
  const barrierIndex = powershell.indexOf("game-data-sync.lock");
  const secretReadIndex = powershell.indexOf("ConvertFrom-Json");
  const nodeStartIndex = powershell.indexOf("& $NodeExe $NodeScript");

  assert.ok(barrierIndex >= 0);
  assert.ok(barrierIndex < secretReadIndex);
  assert.ok(barrierIndex < nodeStartIndex);
  assert.match(nodeEntry, /assertGameDataSyncStartAllowed/);
  assert.match(nodeEntry, /runtimeDir:\s*path\.resolve/);
});

test("cmd entrypoints use CRLF line endings for cmd.exe compatibility", async () => {
  const cmdFiles = (await fs.readdir(rootDir)).filter((name) => name.toLowerCase().endsWith(".cmd"));

  for (const file of cmdFiles) {
    const content = await fs.readFile(path.join(rootDir, file), "utf8");
    assert.match(content, /\r\n/, file);
    assert.equal(/(?<!\r)\n/.test(content), false, file);
  }
});

test("start-system uses lightweight health check and keeps the server in the visible console", async () => {
  const content = await fs.readFile(path.join(rootDir, "work", "start-system.ps1"), "utf8");

  assert.match(content, /\/api\/health/);
  assert.doesNotMatch(content, /\/api\/runtime/);
  assert.doesNotMatch(content, /WindowStyle\s+Hidden/i);
  assert.match(content, /--open/);
  assert.match(content, /&\s*\$NodeExe/);
});

test("startup entrypoints never hide their console windows", async () => {
  const startupFiles = [
    "start-system.cmd",
    "启动系统.cmd",
    path.join("work", "start-system.ps1"),
    path.join("work", "system", "server.mjs"),
  ];

  for (const file of startupFiles) {
    const content = await fs.readFile(path.join(rootDir, file), "utf8");
    assert.doesNotMatch(content, /WindowStyle\s+Hidden/i, file);
    assert.doesNotMatch(content, /windowsHide\s*:\s*true/i, file);
  }
});
