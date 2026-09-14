import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { protectValue, unprotectValue } from "./system/dpapi.mjs";

test("dpapi protects values when inherited PSModulePath contains PowerShell 7 modules", () => {
  if (process.platform !== "win32") {
    return;
  }
  const originalModulePath = process.env.PSModulePath;
  const modulePaths = String(originalModulePath || "").split(path.delimiter).filter(Boolean);
  const powerShell7ModulePath = modulePaths.find((item) => /microsoft\.powershell_\d/i.test(item));
  if (!powerShell7ModulePath) {
    return;
  }

  process.env.PSModulePath = [
    powerShell7ModulePath,
    "C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules",
  ].join(path.delimiter);

  try {
    const plain = "dpapi-psmodulepath-smoke";
    const protectedValue = protectValue(plain);
    assert.equal(unprotectValue(protectedValue), plain);
  }
  finally {
    if (originalModulePath == null) {
      delete process.env.PSModulePath;
    } else {
      process.env.PSModulePath = originalModulePath;
    }
  }
});
