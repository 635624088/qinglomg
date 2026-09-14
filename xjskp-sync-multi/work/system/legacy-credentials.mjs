import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  REQUIRED_CREDENTIAL_FIELDS,
  getMissingCredentialFields,
  normalizeCredentials,
} from "./credentials.mjs";
import { unprotectValue } from "./dpapi.mjs";
import { sanitizeProfileId } from "./profile-store.mjs";

const SENSITIVE_FIELDS = ["CTOKEN", "PC_TOKEN", "BABI_TOKEN", "OPEN_ID"];

export function findLegacySecretPath(rootDir = process.cwd()) {
  if (process.env.XJSKP_LEGACY_SECRET_PATH) {
    return path.resolve(process.env.XJSKP_LEGACY_SECRET_PATH);
  }

  const candidates = [
    path.join(rootDir, "work", "game-secrets.json"),
    path.resolve(rootDir, "..", "..", "work", "game-secrets.json"),
  ];
  const seen = new Set();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    if (fs.existsSync(resolved)) return resolved;
  }
  return path.resolve(candidates[0]);
}

export function createLegacyCredentialMigrator(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const legacySecretPath = path.resolve(options.legacySecretPath || findLegacySecretPath(rootDir));
  const profileStore = options.profileStore || null;
  const unprotect = options.unprotect || unprotectValue;

  async function inspect() {
    const legacy = await readLegacyRecord();
    if (!legacy.exists) {
      return buildMissingStatus({ exists: false });
    }
    if (!legacy.record) {
      return buildMissingStatus({
        exists: true,
        readable: false,
        error: legacy.error,
      });
    }

    const credentialsShape = toCredentialShape(legacy.record);
    const missingFields = getMissingCredentialFields(credentialsShape);
    const pcUserId = String(legacy.record.PC_USER_ID || "").trim();
    const profileId = pcUserId ? sanitizeProfileId(pcUserId) : null;
    return {
      exists: true,
      readable: true,
      complete: missingFields.length === 0,
      source: "work/game-secrets.json",
      profileId,
      label: profileId ? `旧账号 ${profileId}` : "旧账号",
      fields: Object.fromEntries(
        REQUIRED_CREDENTIAL_FIELDS.map((field) => [field, Boolean(credentialsShape[field])]),
      ),
      missingFields,
    };
  }

  async function migrate() {
    if (!profileStore) {
      throw httpError("LEGACY_PROFILE_STORE_MISSING", "Legacy migration requires a profile store.", 500);
    }

    const status = await inspect();
    if (!status.exists) {
      throw httpError("LEGACY_CREDENTIALS_NOT_FOUND", "未找到旧 work/game-secrets.json 凭据。", 404);
    }
    if (!status.complete) {
      throw httpError(
        "LEGACY_CREDENTIALS_INCOMPLETE",
        `旧凭据缺少字段：${status.missingFields.join(", ") || "unknown"}`,
        400,
        { missingFields: status.missingFields },
      );
    }

    const legacy = await readLegacyRecord();
    const credentials = {
      PC_USER_ID: String(legacy.record.PC_USER_ID).trim(),
    };
    for (const field of SENSITIVE_FIELDS) {
      credentials[field] = unprotect(String(legacy.record[field] || ""));
    }

    const normalized = normalizeCredentials(credentials);
    const missingFields = getMissingCredentialFields(normalized);
    if (missingFields.length) {
      throw httpError(
        "LEGACY_CREDENTIALS_UNPROTECT_FAILED",
        `旧凭据解密后仍缺少字段：${missingFields.join(", ")}`,
        400,
        { missingFields },
      );
    }

    const profile = await profileStore.importProfile({
      id: status.profileId,
      label: status.label,
      credentials: normalized,
    });
    return { profile, legacy: status };
  }

  async function readLegacyRecord() {
    try {
      const raw = await fsp.readFile(legacySecretPath);
      return { exists: true, record: parseLegacyJson(raw) };
    } catch (err) {
      if (err.code === "ENOENT") return { exists: false };
      if (err instanceof SyntaxError) {
        return { exists: true, record: null, error: "invalid-json" };
      }
      throw err;
    }
  }

  return {
    legacySecretPath,
    inspect,
    migrate,
  };
}

function parseLegacyJson(buffer) {
  const texts = [];
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    texts.push(buffer.toString("utf16le").replace(/^\uFEFF/, ""));
  } else {
    texts.push(buffer.toString("utf8").replace(/^\uFEFF/, ""));
    texts.push(buffer.toString("utf16le").replace(/^\uFEFF/, ""));
  }

  let lastError = null;
  for (const text of texts) {
    try {
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new SyntaxError("Unable to parse legacy JSON.");
}

function buildMissingStatus(extra = {}) {
  return {
    exists: false,
    readable: true,
    complete: false,
    source: "work/game-secrets.json",
    profileId: null,
    label: null,
    fields: Object.fromEntries(REQUIRED_CREDENTIAL_FIELDS.map((field) => [field, false])),
    missingFields: [...REQUIRED_CREDENTIAL_FIELDS],
    ...extra,
  };
}

function toCredentialShape(record) {
  return normalizeCredentials({
    PC_USER_ID: record.PC_USER_ID,
    ...Object.fromEntries(SENSITIVE_FIELDS.map((field) => [field, record[field] ? "__protected__" : ""])),
  });
}

function httpError(code, message, statusCode, extra = {}) {
  const err = new Error(message);
  err.code = code;
  err.statusCode = statusCode;
  Object.assign(err, extra);
  return err;
}
