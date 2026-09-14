import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ancestor, full } from "acorn-walk";
import { formatJavaScript } from "./format.mjs";
import { writeSnippets } from "./snippets.mjs";

function sourceEntry(name, node, extra = {}) {
  return { name, start: node.start, end: node.end, ...extra };
}

function staticPropertyName(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function staticStringValue(node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? node.quasis[0].value.raw;
  }
  return null;
}

function discoverStringLiteral(found, node) {
  const value = staticStringValue(node);
  if (value === null) return;
  for (const name of value.match(/[A-Za-z_$][A-Za-z0-9_$]*Ctrl\b/g) ?? []) {
    found.controllers.push(sourceEntry(name, node));
  }
  for (const name of value.match(/[A-Za-z_$][A-Za-z0-9_$]*Dlg\b/g) ?? []) {
    found.dialogs.push(sourceEntry(name, node));
  }
  for (const name of value.match(/\bc_[A-Za-z0-9_]+\b/g) ?? []) {
    found.configTables.push(sourceEntry(name, node));
  }
  for (const name of value.match(/\bgs(?:\.[A-Za-z0-9_$]+)+\b/g) ?? []) {
    found.interfaces.push(sourceEntry(name, node));
  }
}

function discoverStringCallSites(found, node, ancestors) {
  const value = staticStringValue(node);
  const parent = ancestors.at(-2);
  if (value === null || parent?.type !== "CallExpression" || !parent.arguments.includes(node)) return;
  for (const name of value.match(/\bgs(?:\.[A-Za-z0-9_$]+)+\b/g) ?? []) {
    found.callSites.push(sourceEntry(name, node));
  }
}

function staticMemberName(node) {
  if (node.type === "Identifier") return node.name;
  if (node.type !== "MemberExpression") return null;
  const propertyName = node.computed
    ? staticPropertyName(node.property)
    : (node.property.type === "Identifier" ? node.property.name : null);
  if (propertyName === null) return null;
  const objectName = staticMemberName(node.object);
  return objectName ? `${objectName}.${propertyName}` : null;
}

function isGsMember(node) {
  const name = staticMemberName(node);
  if (name) return name === "gs" || name.startsWith("gs.");
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "Identifier" && current.name === "gs";
}

function sortAndDedupe(entries, uniqueByName = true) {
  const sorted = [...entries].sort((left, right) => left.name.localeCompare(right.name)
    || left.start - right.start || left.end - right.end);
  const seen = new Set();
  return sorted.filter((entry) => {
    const key = uniqueByName ? entry.name : `${entry.name}:${entry.start}:${entry.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function removeNestedInterfacePrefixes(entries) {
  return entries.filter((entry) => !entries.some((candidate) => candidate.start === entry.start
    && candidate.name.startsWith(`${entry.name}.`)));
}

function convertRangesToUtf8Bytes(source, index) {
  const offsets = [...new Set(Object.values(index).flatMap((entries) => entries
    .flatMap((entry) => [entry.start, entry.end])))].sort((left, right) => left - right);
  const byteOffsets = new Map();
  let previousCodeUnitOffset = 0;
  let previousByteOffset = 0;
  for (const offset of offsets) {
    previousByteOffset += Buffer.byteLength(source.slice(previousCodeUnitOffset, offset), "utf8");
    byteOffsets.set(offset, previousByteOffset);
    previousCodeUnitOffset = offset;
  }
  return Object.fromEntries(Object.entries(index).map(([key, entries]) => [key, entries.map((entry) => ({
    ...entry,
    start: byteOffsets.get(entry.start),
    end: byteOffsets.get(entry.end)
  }))]));
}

export function buildBasicIndex({ source, ast }) {
  const found = {
    controllers: [],
    dialogs: [],
    interfaces: [],
    configTables: [],
    callSites: [],
    unresolved: []
  };

  full(ast, (node) => {
    if (node.type === "Identifier") {
      if (/Ctrl$/.test(node.name)) found.controllers.push(sourceEntry(node.name, node));
      if (/Dlg$/.test(node.name)) found.dialogs.push(sourceEntry(node.name, node));
      if (/^c_[A-Za-z0-9_]+$/.test(node.name)) found.configTables.push(sourceEntry(node.name, node));
    }
    if (node.type === "Literal" || node.type === "TemplateLiteral") {
      discoverStringLiteral(found, node);
    }
    if (node.type === "MemberExpression") {
      const memberName = staticMemberName(node);
      if (memberName?.startsWith("gs.")) found.interfaces.push(sourceEntry(memberName, node));
      if (!memberName && node.computed && isGsMember(node)) {
        found.unresolved.push(sourceEntry(source.slice(node.start, node.end), node, {
          reason: "dynamic-computed-property"
        }));
      }
    }
    if (node.type === "CallExpression") {
      const memberName = staticMemberName(node.callee);
      if (memberName?.startsWith("gs.")) found.callSites.push(sourceEntry(memberName, node.callee));
    }
  });

  ancestor(ast, {
    Literal(node, ancestors) {
      discoverStringCallSites(found, node, ancestors);
    },
    TemplateLiteral(node, ancestors) {
      discoverStringCallSites(found, node, ancestors);
    }
  });

  return convertRangesToUtf8Bytes(source, {
    controllers: sortAndDedupe(found.controllers),
    dialogs: sortAndDedupe(found.dialogs),
    interfaces: sortAndDedupe(removeNestedInterfacePrefixes(found.interfaces)),
    configTables: sortAndDedupe(found.configTables),
    callSites: sortAndDedupe(found.callSites, false),
    unresolved: sortAndDedupe(found.unresolved, false)
  });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeGeneratedArtifacts({ generatedDir, source, ast }) {
  const index = buildBasicIndex({ source, ast });
  await mkdir(generatedDir, { recursive: true });
  await writeFile(path.join(generatedDir, "game.formatted.js"), formatJavaScript(ast), "utf8");
  await Promise.all([
    writeJson(path.join(generatedDir, "controllers.json"), index.controllers),
    writeJson(path.join(generatedDir, "dialogs.json"), index.dialogs),
    writeJson(path.join(generatedDir, "interfaces.json"), index.interfaces),
    writeJson(path.join(generatedDir, "config-tables.json"), index.configTables),
    writeJson(path.join(generatedDir, "call-sites.json"), index.callSites),
    writeJson(path.join(generatedDir, "unresolved.json"), index.unresolved)
  ]);
  await writeSnippets({
    snippetsDir: path.join(generatedDir, "snippets"),
    source,
    entries: Object.values(index).flat()
  });
  return index;
}
