import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const EXCLUDED_DIRECTORIES = new Set([
  "game-pkg",
  "game-pkg-latest",
  "node_modules",
  "outputs",
  "runtime",
]);
const INTERFACE_LITERAL_PATTERN = /(["'`])(gs\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\1/g;
const SCHEMA_LITERAL_PATTERN = /(["'`])(G\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\1/g;
const SCHEMA_NEEDLE = "mo.DS.setSingle(";

export function collectProductionInterfaceReferences({ sourceDir = "work" } = {}) {
  return collectProductionLiterals(sourceDir, INTERFACE_LITERAL_PATTERN);
}

export function collectProductionSchemaReferences({ sourceDir = "work" } = {}) {
  return collectProductionLiterals(sourceDir, SCHEMA_LITERAL_PATTERN);
}

export function extractGameSchemas(source = "") {
  const text = String(source || "");
  const schemas = {};
  let position = 0;
  while ((position = text.indexOf(SCHEMA_NEEDLE, position)) >= 0) {
    const nameStart = position + SCHEMA_NEEDLE.length;
    const quote = text[nameStart];
    if (!['"', "'", "`"].includes(quote)) {
      position = nameStart + 1;
      continue;
    }
    const nameEnd = findStringEnd(text, nameStart, quote);
    if (nameEnd < 0) break;
    const name = text.slice(nameStart + 1, nameEnd);
    const objectStart = text.indexOf("{", nameEnd + 1);
    const argumentEnd = text.indexOf(")", nameEnd + 1);
    if (objectStart < 0 || (argumentEnd >= 0 && argumentEnd < objectStart)) {
      position = nameEnd + 1;
      continue;
    }
    const objectEnd = findBalancedObjectEnd(text, objectStart);
    if (objectEnd < 0) {
      position = objectStart + 1;
      continue;
    }
    try {
      const literal = text.slice(objectStart, objectEnd + 1);
      const value = vm.runInNewContext(`(${literal})`, Object.create(null), {
        timeout: 50,
        contextCodeGeneration: { strings: false, wasm: false },
      });
      if (value && typeof value === "object" && !Array.isArray(value)) {
        schemas[name] = JSON.parse(JSON.stringify(value));
      }
    } catch {
      // A declaration that cannot be evaluated as a standalone data object is
      // intentionally omitted; required-schema auditing then fails closed.
    }
    position = objectEnd + 1;
  }
  return schemas;
}

export function interfaceToIArgSchema(interfaceName) {
  const parts = String(interfaceName || "").split(".");
  if (parts.length !== 3 || parts[0] !== "gs" || !parts[1] || !parts[2]) return null;
  return `G.GS.${parts[1]}Iface.IArg_${parts[2]}`;
}

export function auditGameCodeCompatibility(options = {}) {
  const baselineSource = String(options.baselineGameJsSource || "");
  const candidateSource = String(options.candidateGameJsSource || "");
  const baselineSchemas = extractGameSchemas(baselineSource);
  const candidateSchemas = extractGameSchemas(candidateSource);
  const interfaces = uniqueSorted(options.interfaces || (
    options.productionSourceDir
      ? collectProductionInterfaceReferences({ sourceDir: options.productionSourceDir })
      : []
  ));
  const requiredSchemas = uniqueSorted([
    "G.ISyncData",
    ...(options.requiredSchemas || []),
    ...(options.productionSourceDir
      ? collectProductionSchemaReferences({ sourceDir: options.productionSourceDir })
      : []),
  ]);
  const reasons = [];
  const interfaceAudit = {
    referencedCount: interfaces.length,
    preserved: [],
    provenByIArg: [],
    removed: [],
    unverified: [],
  };

  for (const interfaceName of interfaces) {
    const schemaName = interfaceToIArgSchema(interfaceName);
    const baselineLiteral = baselineSource.includes(interfaceName);
    const candidateLiteral = candidateSource.includes(interfaceName);
    const baselineSchema = Boolean(schemaName && baselineSchemas[schemaName]);
    const candidateSchema = Boolean(schemaName && candidateSchemas[schemaName]);
    const baselineSupported = baselineLiteral || baselineSchema;
    const candidateSupported = candidateLiteral || candidateSchema;
    if (baselineSupported && candidateSupported) {
      interfaceAudit.preserved.push(interfaceName);
      if (!candidateLiteral && candidateSchema) interfaceAudit.provenByIArg.push(interfaceName);
    } else if (baselineSupported) {
      interfaceAudit.removed.push(interfaceName);
      reasons.push(`removed-interface:${interfaceName}`);
    } else if (!candidateSupported) {
      interfaceAudit.unverified.push(interfaceName);
      reasons.push(`unverified-interface:${interfaceName}`);
    } else {
      interfaceAudit.preserved.push(interfaceName);
      if (!candidateLiteral && candidateSchema) interfaceAudit.provenByIArg.push(interfaceName);
    }
  }

  const schemaAudit = compareSchemaClosure({
    baselineSchemas,
    candidateSchemas,
    requiredSchemas,
  });
  reasons.push(...schemaAudit.reasons);
  const uniqueReasons = [...new Set(reasons)];
  return {
    status: uniqueReasons.length === 0 ? "compatible" : "incompatible",
    reasons: uniqueReasons,
    interfaces: interfaceAudit,
    schemas: schemaAudit,
  };
}

function compareSchemaClosure({ baselineSchemas, candidateSchemas, requiredSchemas }) {
  const reasons = [];
  const checked = [];
  const pending = [...requiredSchemas];
  const seen = new Set();
  while (pending.length > 0) {
    const schemaName = pending.shift();
    if (!schemaName || seen.has(schemaName)) continue;
    seen.add(schemaName);
    const baseline = baselineSchemas[schemaName];
    const candidate = candidateSchemas[schemaName];
    if (!baseline) {
      reasons.push(`baseline-missing-schema:${schemaName}`);
      continue;
    }
    if (!candidate) {
      reasons.push(`missing-schema:${schemaName}`);
      continue;
    }
    checked.push(schemaName);
    const namespace = schemaNamespace(schemaName);
    for (const [field, baselineSpec] of Object.entries(baseline)) {
      if (!Object.hasOwn(candidate, field)) {
        reasons.push(`schema-field-removed:${schemaName}.${field}`);
        continue;
      }
      const before = parseSchemaField(baselineSpec, namespace);
      const after = parseSchemaField(candidate[field], namespace);
      if (before.index !== after.index) {
        reasons.push(`schema-field-index-changed:${schemaName}.${field}:${before.index}->${after.index}`);
      }
      if (before.type !== after.type) {
        reasons.push(`schema-field-type-changed:${schemaName}.${field}:${before.type || "null"}->${after.type || "null"}`);
      }
      for (const dependency of schemaDependencies(before.type)) {
        if (baselineSchemas[dependency] && !seen.has(dependency)) pending.push(dependency);
      }
    }
  }
  return {
    required: requiredSchemas,
    checked: checked.sort(),
    reasons,
  };
}

function parseSchemaField(spec, namespace) {
  if (typeof spec === "number") return { index: String(spec), type: null };
  const text = String(spec);
  const separator = text.indexOf(":");
  if (separator < 0) return { index: text, type: null };
  return {
    index: text.slice(0, separator),
    type: normalizeSchemaType(text.slice(separator + 1).trim(), namespace),
  };
}

function normalizeSchemaType(type, namespace) {
  if (!type) return null;
  if (type.endsWith("[]")) return `${normalizeSchemaType(type.slice(0, -2), namespace)}[]`;
  if (type.includes(".")) return type;
  if (["number", "string", "boolean", "any", "Date", "INumMap"].includes(type)) return type;
  if (type.startsWith("{")) return type.replace(/\s+/g, "");
  return `${namespace}.${type}`;
}

function schemaDependencies(type) {
  if (!type) return [];
  return [...String(type).matchAll(/G\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)].map((match) => match[0]);
}

function schemaNamespace(schemaName) {
  const index = schemaName.lastIndexOf(".");
  return index > 0 ? schemaName.slice(0, index) : "G";
}

function collectProductionLiterals(sourceDir, pattern) {
  const found = new Set();
  const root = path.resolve(sourceDir);
  if (!fs.existsSync(root)) return [];
  visitProductionFiles(root, (filePath) => {
    const source = fs.readFileSync(filePath, "utf8");
    for (const match of source.matchAll(pattern)) found.add(match[2]);
  });
  return [...found].sort();
}

function visitProductionFiles(directory, visit) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) visitProductionFiles(path.join(directory, entry.name), visit);
      continue;
    }
    if (!entry.isFile() || !/\.(?:mjs|js)$/i.test(entry.name)) continue;
    if (/\.test\.(?:mjs|js)$/i.test(entry.name)) continue;
    if (entry.name === "sync-latest-static-config.mjs") continue;
    visit(path.join(directory, entry.name));
  }
}

function findStringEnd(text, start, quote) {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) escaped = false;
    else if (char === "\\") escaped = true;
    else if (char === quote) return index;
  }
  return -1;
}

function findBalancedObjectEnd(text, start) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (['"', "'", "`"].includes(char)) quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index;
  }
  return -1;
}

function uniqueSorted(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}
