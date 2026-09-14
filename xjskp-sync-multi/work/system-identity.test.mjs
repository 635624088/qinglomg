import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const packageName = "xjskp-sync-multi-next";
const releasePathPattern = /release\\xjskp-sync-multi-next/i;

test("isolated package identity and default port do not fall back to sync-multi", async () => {
  const [packageText, serverText, marker, readme] = await Promise.all([
    fs.readFile(path.join(rootDir, "package.json"), "utf8"),
    fs.readFile(path.join(rootDir, "work", "system", "server.mjs"), "utf8"),
    fs.readFile(path.join(rootDir, "PORTABLE-RUNTIME.txt"), "utf8"),
    fs.readFile(path.join(rootDir, "README.md"), "utf8"),
  ]);

  assert.equal(JSON.parse(packageText).name, packageName);
  assert.match(serverText, /const DEFAULT_PORT = 43722;/);
  assert.doesNotMatch(serverText, /const DEFAULT_PORT = 43721;/);
  assert.match(serverText, /async function listen\(preferredPort = DEFAULT_PORT\)/);
  assert.match(serverText, /Number\(process\.env\.XJSKP_SYSTEM_PORT \|\| DEFAULT_PORT\)/);
  assert.match(marker, /xjskp-sync-multi-next portable runtime/);
  assert.match(readme, /release\\xjskp-sync-multi-next/);

  for (const file of ["start-system.cmd", "stop-system.cmd", "run-auto-plant.cmd", "run-auto-plant-once.cmd", "reset-auto-plant-secrets.cmd", "重置账号凭据.cmd"]) {
    const content = await fs.readFile(path.join(rootDir, file), "utf8");
    assert.match(content, releasePathPattern, file);
    assert.doesNotMatch(content, /release\\xjskp-sync-multi(?!-next)/i, file);
  }
});
