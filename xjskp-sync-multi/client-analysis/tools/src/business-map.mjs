import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INDEX_KINDS = [
  ["controllers", "controller"],
  ["dialogs", "dialog"],
  ["interfaces", "interface"],
  ["configTables", "config-table"],
  ["callSites", "call-site"],
  ["unresolved", "unresolved"]
];

const DOMAIN_MATCHERS = [
  ["garden", /land|garden|plant|seed|water|farm/i],
  ["flower", /flower/i],
  ["market", /market|shop|trade|sell|buy/i],
  ["order", /order/i],
  ["task", /task/i],
  ["story", /story|plot|chapter/i],
  ["account", /usr|user|account|role|profile/i]
];

function sourceId(kind, entry) {
  return `${kind}:${entry.name}:${entry.start}:${entry.end}`;
}

function activityDomain(name) {
  if (/^(Act(?:Ctrl|Controller)|PAct[A-Za-z0-9_]*Dlg|gs\.act(?:\.|$)|c_act(?:$|_))/i.test(name)) {
    return "activity-framework";
  }
  const match = name.match(/^(?:P)?([A-Za-z0-9_]+)Act(?:Ctrl|Controller|Dlg)$/i)
    ?? name.match(/^gs\.([A-Za-z0-9_]+)Act(?:\.|$)/i)
    ?? name.match(/^c_([A-Za-z0-9_]+)Act$/i);
  return match ? `activity-instance:${match[1].toLowerCase()}` : null;
}

function classifyName(name) {
  const activity = activityDomain(name);
  if (activity) return activity;
  return DOMAIN_MATCHERS.find(([, pattern]) => pattern.test(name))?.[0] ?? "unclassified";
}

function classifyEntry(sourceKey, entry) {
  if (sourceKey === "unresolved") {
    return { domainId: "unclassified", reason: "missing-static-evidence" };
  }
  const domainId = classifyName(entry.name);
  return {
    domainId,
    reason: domainId === "unclassified" ? "no-client-domain-evidence" : undefined
  };
}

function sortById(entries) {
  return [...entries].sort((left, right) => left.id.localeCompare(right.id));
}

function domainTitle(domainId) {
  if (!domainId.startsWith("activity-instance:")) return domainId;
  return `activity instance: ${domainId.slice("activity-instance:".length)}`;
}

function buildCatalog(map) {
  const lines = [
    "# Generated client business catalog",
    "",
    "此文件由客户端机器索引生成；仅作为业务目录草案，不替代人工客户端事实文档。",
    "",
    "| 业务域 | 发现项 | 证据类型 |",
    "| --- | ---: | --- |"
  ];
  for (const domain of map.domains) {
    lines.push(`| ${domainTitle(domain.id)} | ${domain.nodeIds.length} | ${domain.evidenceKinds.join(", ")} |`);
  }
  const reasons = Object.entries(map.statistics.unclassifiedByReason)
    .map(([reason, count]) => `${reason}=${count}`).join(", ");
  lines.push("", `未分类发现项：${map.statistics.unclassified}。`, `未分类原因：${reasons || "无"}。`);
  return `${lines.join("\n")}\n`;
}

function escapeMarkdownCell(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("`", "\\`");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function buildUnclassifiedReport(map, appVersion) {
  const lines = [
    "# Generated unclassified client findings",
    "",
    `客户端版本限定：\`${escapeMarkdownCell(appVersion ?? "unknown")}\`。`,
    `未分类总数：${map.statistics.unclassified}。`,
    "",
    "## 未分类原因",
    "",
    "| 原因 | 数量 |",
    "| --- | ---: |"
  ];
  const reasons = Object.entries(map.statistics.unclassifiedByReason)
    .sort(([left], [right]) => compareText(left, right));
  if (reasons.length === 0) {
    lines.push("| 无 | 0 |");
  } else {
    for (const [reason, count] of reasons) {
      lines.push(`| ${escapeMarkdownCell(reason)} | ${count} |`);
    }
  }
  lines.push("", "## 未分类节点", "");
  if (map.unclassified.length === 0) {
    lines.push("无未分类发现项。");
  } else {
    lines.push(
      "| 标识 | 类型 | 名称 | 原始范围 | 原因 |",
      "| --- | --- | --- | --- | --- |"
    );
    const nodes = [...map.unclassified].sort((left, right) => compareText(left.id, right.id));
    for (const node of nodes) {
      lines.push(`| ${escapeMarkdownCell(node.id)} | ${escapeMarkdownCell(node.kind)} | ${escapeMarkdownCell(node.name)} | ${node.start}-${node.end} | ${escapeMarkdownCell(node.reason)} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function buildBusinessMap(indexes) {
  const nodes = [];
  for (const [sourceKey, kind] of INDEX_KINDS) {
    for (const entry of indexes[sourceKey] ?? []) {
      const classification = classifyEntry(sourceKey, entry);
      nodes.push({
        id: sourceId(kind, entry),
        kind,
        name: entry.name,
        start: entry.start,
        end: entry.end,
        ...classification,
        ...(sourceKey === "unresolved" && entry.reason !== undefined
          ? { sourceReason: entry.reason }
          : {})
      });
    }
  }
  const sortedNodes = sortById(nodes);
  const interfaces = new Map(sortedNodes.filter((node) => node.kind === "interface")
    .map((node) => [node.name, node]));
  const edges = sortById(sortedNodes.filter((node) => node.kind === "call-site")
    .flatMap((node) => {
      const target = interfaces.get(node.name);
      return target ? [{
        id: `calls:${node.id}->${target.id}`,
        type: "calls",
        from: node.id,
        to: target.id
      }] : [];
    }));
  const domainMap = new Map();
  for (const node of sortedNodes) {
    if (node.domainId === "unclassified") continue;
    const domain = domainMap.get(node.domainId) ?? { id: node.domainId, nodeIds: [], evidenceKinds: [] };
    domain.nodeIds.push(node.id);
    if (!domain.evidenceKinds.includes(node.kind)) domain.evidenceKinds.push(node.kind);
    domainMap.set(node.domainId, domain);
  }
  const domains = sortById([...domainMap.values()].map((domain) => ({
    ...domain,
    nodeIds: domain.nodeIds.sort(),
    evidenceKinds: domain.evidenceKinds.sort()
  })));
  const unclassified = sortedNodes.filter((node) => node.domainId === "unclassified");
  const unclassifiedByReason = Object.fromEntries([...unclassified.reduce((counts, node) => {
    counts.set(node.reason, (counts.get(node.reason) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort(([left], [right]) => left.localeCompare(right)));
  return {
    nodes: sortedNodes,
    edges,
    domains,
    unclassified,
    statistics: {
      discovered: sortedNodes.length,
      classified: sortedNodes.length - unclassified.length,
      unclassified: unclassified.length,
      unclassifiedByReason,
      domains: domains.length
    }
  };
}

export async function writeBusinessMapArtifacts({ generatedDir, reportsDir, indexes, appVersion }) {
  const map = buildBusinessMap(indexes);
  await mkdir(generatedDir, { recursive: true });
  await mkdir(reportsDir, { recursive: true });
  await Promise.all([
    writeFile(path.join(generatedDir, "business-map.json"), `${JSON.stringify(map, null, 2)}\n`, "utf8"),
    writeFile(path.join(reportsDir, "business-catalog.md"), buildCatalog(map), "utf8"),
    writeFile(path.join(reportsDir, "unclassified.md"), buildUnclassifiedReport(map, appVersion), "utf8")
  ]);
  return map;
}
