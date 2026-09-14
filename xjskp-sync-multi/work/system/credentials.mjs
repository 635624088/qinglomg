export const REQUIRED_CREDENTIAL_FIELDS = [
  "CTOKEN",
  "PC_USER_ID",
  "PC_TOKEN",
  "BABI_TOKEN",
  "OPEN_ID",
];

const FIELD_ALIASES = {
  CTOKEN: ["ctoken", "bigfish_ctoken"],
  PC_USER_ID: ["pc_user_id", "pcuserid", "pcuserId", "userId", "userid", "uid"],
  PC_TOKEN: ["pc_token", "pctoken", "x-game-token-pcweb", "x_game_token_pcweb"],
  BABI_TOKEN: ["babi_token", "babitoken", "x-babigame-token", "x_babigame_token", "token"],
  OPEN_ID: ["open_id", "openid", "_openid"],
};

const ALIAS_TO_FIELD = new Map();
for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
  ALIAS_TO_FIELD.set(normalizeKey(field), field);
  for (const alias of aliases) {
    ALIAS_TO_FIELD.set(normalizeKey(alias), field);
  }
}

export function parseCredentialInput(input = "") {
  const text = String(input ?? "");
  const result = {};
  collectFromJson(text, result);
  collectExplicitAssignments(text, result);
  collectCookieText(text, result);
  collectHeaderLines(text, result);
  return normalizeCredentials(result);
}

export function getMissingCredentialFields(credentials = {}) {
  const normalized = normalizeCredentials(credentials);
  return REQUIRED_CREDENTIAL_FIELDS.filter((field) => !normalized[field]);
}

export function normalizeCredentials(credentials = {}) {
  const normalized = {};
  for (const field of REQUIRED_CREDENTIAL_FIELDS) {
    const value = credentials[field];
    if (value != null && String(value).trim()) {
      normalized[field] = String(value).trim();
    }
  }
  return normalized;
}

function collectExplicitAssignments(text, result) {
  const fieldNames = [
    ...REQUIRED_CREDENTIAL_FIELDS,
    ...Object.values(FIELD_ALIASES).flat(),
  ];
  for (const name of fieldNames) {
    const pattern = new RegExp(
      String.raw`(?:^|[\s;&"'` + "`" + String.raw`])${escapeRegExp(name)}\s*[:=]\s*(?:"([^"]+)"|'([^']+)'|([^\s;&"'` + "`" + String.raw`]+))`,
      "gim",
    );
    let match;
    while ((match = pattern.exec(text))) {
      assignAlias(result, name, match[1] ?? match[2] ?? match[3]);
    }
  }
}

function collectCookieText(text, result) {
  const cookieHeaderPattern = /(?:Cookie|cookie)\s*:\s*("?)([^"\r\n]+)/g;
  let match;
  while ((match = cookieHeaderPattern.exec(text))) {
    collectCookiePairs(match[2], result);
  }
  collectCookiePairs(text, result);
}

function collectHeaderLines(text, result) {
  const headerPattern = /(?:-H\s+)?["']?([A-Za-z0-9_-]+)\s*:\s*([^"'\r\n]+)/g;
  let match;
  while ((match = headerPattern.exec(text))) {
    const name = match[1];
    const value = match[2].trim().replace(/[\\^]+$/, "").trim();
    if (normalizeKey(name) === "cookie") {
      collectCookiePairs(value, result);
    } else {
      assignAlias(result, name, value);
    }
  }
}

function collectFromJson(text, result) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return;
  try {
    visitJson(JSON.parse(trimmed), result);
  } catch {
    // Non-JSON input is expected for cURL and copied request headers.
  }
}

function visitJson(value, result, key = "") {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === "object" && "name" in item && "value" in item) {
        assignAlias(result, item.name, item.value);
      }
      visitJson(item, result, key);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    if (key) assignAlias(result, key, value);
    return;
  }
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === "cookies" || childKey === "headers") {
      visitJson(childValue, result, childKey);
    } else if (childValue && typeof childValue === "object") {
      visitJson(childValue, result, childKey);
    } else {
      assignAlias(result, childKey, childValue);
    }
  }
}

function collectCookiePairs(cookieText, result) {
  for (const pair of String(cookieText ?? "").split(";")) {
    const idx = pair.indexOf("=");
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim();
    const value = decodeCookieValue(pair.slice(idx + 1).trim());
    assignAlias(result, name, value);
  }
}

function assignAlias(result, rawName, rawValue) {
  const value = String(rawValue ?? "").trim().replace(/^["']|["']$/g, "");
  if (!value) return;
  const normalizedName = normalizeKey(rawName);
  let field = ALIAS_TO_FIELD.get(normalizedName);
  if (!field && normalizedName.startsWith("bigfish_ctoken")) {
    field = "CTOKEN";
  }
  if (!field) return;
  if (!result[field]) {
    result[field] = value;
  }
}

function normalizeKey(key) {
  return String(key ?? "").trim().replace(/-/g, "_").toLowerCase();
}

function decodeCookieValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
