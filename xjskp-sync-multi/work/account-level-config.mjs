import fs from "node:fs";

import { decodeConfigRows, findConfigTable } from "./flower-level-config.mjs";
import { getDefaultStaticConfigPath } from "./static-config-path.mjs";

export function loadAccountLevelConfig(configPath = getDefaultStaticConfigPath()) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const table = findConfigTable(config, "c_lvl");
  if (!table) throw new Error("Cannot find config table: c_lvl");
  const rows = decodeConfigRows(table, "c_lvl");
  const levels = new Map();
  for (const row of rows) {
    const level = finiteNumber(row.id ?? row.lvl ?? row.level);
    const exp = finiteNumber(row.exp);
    if (level != null && level > 0 && exp != null && exp >= 0) levels.set(level, row);
  }
  return {
    sourcePath: configPath,
    levels,
    compatible: levels.size > 0,
    reasons: levels.size > 0 ? [] : ["account-level-table-empty"],
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
