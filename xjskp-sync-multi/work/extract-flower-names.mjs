import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_INPUT = getDefaultStaticConfigPath();
const DEFAULT_OUTPUT = path.join(__dirname, "flower-names.json");
const STATIC_DATA_URL = "https://hygncdn.babigame.cn/assets/resources/native/35/35fc3381-34dc-5c64-ba90-e06c2c6133a8.69b61.text";

function getArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function decryptCharCodes(value, key = "smallaitt") {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const codes = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);
  const scrambled = codes.map((code) => String.fromCharCode(code)).join("");
  let out = "";

  for (const char of scrambled) {
    let code = char.charCodeAt(0);
    for (let i = key.length - 1; i >= 0; i -= 1) {
      code ^= key.charCodeAt(i);
    }
    out += String.fromCharCode(code);
  }

  return out;
}

async function readConfigText(inputPath) {
  if (/^https?:\/\//i.test(inputPath)) {
    const response = await fetch(inputPath);
    if (!response.ok) throw new Error(`Failed to download config: HTTP ${response.status}`);
    return response.text();
  }

  if (fs.existsSync(inputPath)) return fs.readFileSync(inputPath, "utf8");

  const response = await fetch(STATIC_DATA_URL);
  if (!response.ok) throw new Error(`Failed to download config: HTTP ${response.status}`);
  const text = await response.text();
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  fs.writeFileSync(inputPath, text, "utf8");
  return text;
}

function tableName(encryptedName, table) {
  return table?.a ? decryptCharCodes(encryptedName, String(table.a)) : encryptedName;
}

function findTable(config, targetName) {
  for (const [encryptedName, table] of Object.entries(config)) {
    if (tableName(encryptedName, table) === targetName) return table;
  }
  throw new Error(`Cannot find config table: ${targetName}`);
}

function decodeFieldMap(table) {
  if (!table.m) return {};
  return JSON.parse(decryptCharCodes(table.m, String(table.a)));
}

function invertMap(map) {
  const out = {};
  for (const [fieldName, encodedName] of Object.entries(map)) {
    if (!fieldName.startsWith("$")) out[encodedName] = fieldName;
  }
  return out;
}

function decodeRows(table) {
  const fieldByEncodedName = invertMap(decodeFieldMap(table));
  const rows = [];

  for (const block of table.list || []) {
    for (const [id, row] of Object.entries(block.v || {})) {
      const decoded = { id };
      for (const [encodedName, value] of Object.entries(row)) {
        decoded[fieldByEncodedName[encodedName] || encodedName] = value;
      }
      rows.push(decoded);
    }
  }

  return rows;
}

function normalizeName(value) {
  return String(value ?? "").trim();
}

export function buildFlowerNameMap(config) {
  const itemRows = decodeRows(findTable(config, "c_item"));
  const flowerRows = decodeRows(findTable(config, "c_flower"));
  const itemById = new Map(itemRows.map((row) => [String(row.id), row]));
  const names = {};

  for (const flower of flowerRows) {
    const item = itemById.get(String(flower.id));
    const name = normalizeName(item?.name || item?.name1 || item?.sname);
    if (name && name !== "0") names[String(flower.id)] = name;
  }

  for (const item of itemRows) {
    const name = normalizeName(item.name || item.name1 || item.sname);
    if (Number(item.bType) === 2 && name && name !== "0") {
      names[String(item.id)] = name;
    }
  }

  const sorted = Object.fromEntries(
    Object.entries(names).sort(([a], [b]) => Number(a) - Number(b)),
  );
  return sorted;
}

async function main() {
  const inputPath = getArg("input", DEFAULT_INPUT);
  const outputPath = getArg("output", DEFAULT_OUTPUT);
  const config = JSON.parse(await readConfigText(inputPath));
  const sorted = buildFlowerNameMap(config);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");

  const sample = Object.entries(sorted).slice(0, 5)
    .map(([id, name]) => `${id}:${name}`)
    .join(", ");
  console.log(`Generated ${Object.keys(sorted).length} flower names: ${outputPath}`);
  console.log(`Sample: ${sample}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
