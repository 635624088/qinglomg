import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  findLatestStaticConfigPath,
  parseStaticConfigVersion,
} from "./static-config-path.mjs";

test("parseStaticConfigVersion extracts numeric and hex-like versions", () => {
  assert.equal(parseStaticConfigVersion("work/g-data.29829.text"), 29829);
  assert.equal(parseStaticConfigVersion("C:/tmp/g-data.69b61.text"), 0x69b61);
  assert.equal(parseStaticConfigVersion("work/not-data.text"), null);
});

test("findLatestStaticConfigPath selects the highest local g-data version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-static-config-"));
  try {
    fs.writeFileSync(path.join(dir, "g-data.29829.text"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "g-data.69b61.text"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "g-data.00010.text"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "g-data.bad-version.json"), "{}", "utf8");

    assert.equal(
      findLatestStaticConfigPath({ dir }),
      path.join(dir, "g-data.69b61.text"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findLatestStaticConfigPath prefers current package referenced g-data over higher stale local version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-static-config-package-"));
  try {
    const tarDir = path.join(dir, "game-pkg-latest", "tar");
    fs.mkdirSync(tarDir, { recursive: true });
    fs.writeFileSync(
      path.join(tarDir, "modules.json"),
      JSON.stringify({ main: ["assets/resources/index.bce02.js"] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "resources-config-bce02.json"),
      JSON.stringify({
        paths: {
          2975: ["mo/zh/data/g-data", 0, 1],
        },
        versions: {
          native: [2975, "6cfce"],
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "g-data.6cfce.text"), "{}", "utf8");
    fs.writeFileSync(path.join(dir, "g-data.fe15e.text"), "{}", "utf8");

    assert.equal(
      findLatestStaticConfigPath({ dir }),
      path.join(dir, "g-data.6cfce.text"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("findLatestStaticConfigPath prefers the verified active data pointer over the local package", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-static-config-active-"));
  const dir = path.join(rootDir, "work");
  try {
    const tarDir = path.join(dir, "game-pkg-latest", "tar");
    fs.mkdirSync(tarDir, { recursive: true });
    fs.writeFileSync(
      path.join(tarDir, "modules.json"),
      JSON.stringify({ main: ["assets/resources/index.bce02.js"] }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(dir, "resources-config-bce02.json"),
      JSON.stringify({
        paths: { 2975: ["mo/zh/data/g-data", 0, 1] },
        versions: { native: [2975, "6cfce"] },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "g-data.6cfce.text"), "{}", "utf8");
    writeActiveBundleSync(rootDir, "2f3f6");

    assert.equal(
      findLatestStaticConfigPath({ dir, rootDir }),
      path.join(rootDir, "runtime", "game-data", "versions", "2f3f6", "g-data.2f3f6.text"),
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("findLatestStaticConfigPath falls back when the active pointer is incomplete", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-static-config-invalid-active-"));
  const dir = path.join(rootDir, "work");
  try {
    fs.mkdirSync(path.join(rootDir, "runtime", "status"), { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, "runtime", "status", "game-data-active.json"),
      JSON.stringify({ schemaVersion: 1, activeDataVersion: "missing" }),
      "utf8",
    );
    fs.writeFileSync(path.join(dir, "g-data.69b61.text"), "{}", "utf8");

    assert.equal(
      findLatestStaticConfigPath({ dir, rootDir }),
      path.join(dir, "g-data.69b61.text"),
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("findLatestStaticConfigPath falls back to the bundled baseline", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xjskp-static-config-empty-"));
  try {
    assert.equal(
      findLatestStaticConfigPath({ dir }),
      path.join(dir, "g-data.69b61.text"),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeActiveBundleSync(rootDir, dataVersion) {
  const versionDir = path.join(rootDir, "runtime", "game-data", "versions", dataVersion);
  fs.mkdirSync(versionDir, { recursive: true });
  fs.mkdirSync(path.join(rootDir, "runtime", "status"), { recursive: true });
  const configFile = `g-data.${dataVersion}.text`;
  const configText = "{}";
  const flowerNamesText = "{}";
  const compatibilityReportText = JSON.stringify({ schemaVersion: 1, dataVersion, status: "compatible" });
  fs.writeFileSync(path.join(versionDir, configFile), configText, "utf8");
  fs.writeFileSync(path.join(versionDir, "flower-names.json"), flowerNamesText, "utf8");
  fs.writeFileSync(
    path.join(versionDir, "compatibility-report.json"),
    compatibilityReportText,
    "utf8",
  );
  fs.writeFileSync(
    path.join(versionDir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      dataVersion,
      sourceCodeVersion: "400.0.15",
      configFile,
      flowerNamesFile: "flower-names.json",
      compatibilityReportFile: "compatibility-report.json",
      compatibilityStatus: "compatible",
      files: {
        [configFile]: fileEvidence(configText),
        "flower-names.json": fileEvidence(flowerNamesText),
        "compatibility-report.json": fileEvidence(compatibilityReportText),
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "runtime", "status", "game-data-active.json"),
    JSON.stringify({ schemaVersion: 1, activeDataVersion: dataVersion }),
    "utf8",
  );
}

function fileEvidence(text) {
  return {
    bytes: Buffer.byteLength(text),
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}
