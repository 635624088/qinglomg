import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLegacyCredentialMigrator } from "./system/legacy-credentials.mjs";
import { createProfileStore } from "./system/profile-store.mjs";

test("legacy credential migrator reports complete old game-secrets without leaking values", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-legacy-"));
  try {
    const legacySecretPath = path.join(dir, "game-secrets.json");
    await writeFile(legacySecretPath, JSON.stringify({
      CTOKEN: "old:ctoken-secret",
      PC_USER_ID: "2088123456789012",
      PC_TOKEN: "old:pc-token-secret",
      BABI_TOKEN: "old:babi-token-secret",
      OPEN_ID: "old:open-id-secret",
    }), "utf8");

    const migrator = createLegacyCredentialMigrator({ legacySecretPath });
    const status = await migrator.inspect();

    assert.equal(status.exists, true);
    assert.equal(status.complete, true);
    assert.equal(status.profileId, "2088123456789012");
    assert.deepEqual(status.missingFields, []);
    assert.equal(JSON.stringify(status).includes("ctoken-secret"), false);
    assert.equal(JSON.stringify(status).includes("pc-token-secret"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy credential migrator reads Windows PowerShell UTF-16 legacy secrets", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-legacy-"));
  try {
    const legacySecretPath = path.join(dir, "game-secrets.json");
    await writeFile(legacySecretPath, JSON.stringify({
      CTOKEN: "old:ctoken-secret",
      PC_USER_ID: "2088123456789012",
      PC_TOKEN: "old:pc-token-secret",
      BABI_TOKEN: "old:babi-token-secret",
      OPEN_ID: "old:open-id-secret",
    }), "utf16le");

    const migrator = createLegacyCredentialMigrator({ legacySecretPath });
    const status = await migrator.inspect();

    assert.equal(status.exists, true);
    assert.equal(status.readable, true);
    assert.equal(status.complete, true);
    assert.equal(status.profileId, "2088123456789012");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("legacy credential migrator converts old DPAPI secrets into a complete profile without plaintext persistence", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "xjskp-legacy-"));
  try {
    const legacySecretPath = path.join(dir, "game-secrets.json");
    const accountsDir = path.join(dir, "accounts");
    await writeFile(legacySecretPath, JSON.stringify({
      CTOKEN: "old:ctoken-secret",
      PC_USER_ID: "2088123456789012",
      PC_TOKEN: "old:pc-token-secret",
      BABI_TOKEN: "old:babi-token-secret",
      OPEN_ID: "old:open-id-secret",
    }), "utf8");

    const store = createProfileStore({
      accountsDir,
      protect: (value) => `new:${Buffer.from(value, "utf8").toString("base64")}`,
      unprotect: (value) => Buffer.from(value.slice("new:".length), "base64").toString("utf8"),
      now: () => new Date("2026-06-30T04:00:00.000Z"),
    });
    const migrator = createLegacyCredentialMigrator({
      legacySecretPath,
      profileStore: store,
      unprotect: (value) => value.slice("old:".length),
    });

    const result = await migrator.migrate();

    assert.equal(result.profile.id, "2088123456789012");
    assert.equal(result.profile.label, "旧账号 2088123456789012");
    assert.equal(result.profile.hasCredentials, true);
    assert.deepEqual(result.profile.missingFields, []);
    assert.deepEqual(await store.loadProfileEnv("2088123456789012"), {
      CTOKEN: "ctoken-secret",
      PC_USER_ID: "2088123456789012",
      PC_TOKEN: "pc-token-secret",
      BABI_TOKEN: "babi-token-secret",
      OPEN_ID: "open-id-secret",
    });

    const saved = await readFile(path.join(accountsDir, "2088123456789012.json"), "utf8");
    assert.equal(saved.includes("ctoken-secret"), false);
    assert.equal(saved.includes("pc-token-secret"), false);
    assert.equal(saved.includes("old:"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
