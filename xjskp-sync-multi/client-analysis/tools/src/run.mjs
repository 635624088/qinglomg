import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeBusinessMapArtifacts } from "./business-map.mjs";
import { readClientInput } from "./input.mjs";
import { writeGeneratedArtifacts } from "./indexer.mjs";
import { parseJavaScript } from "./parser.mjs";
import { publishClientVersion } from "./publish.mjs";

function elapsedMilliseconds(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1_000_000);
}

function buildDiscoveryCounts(indexes, businessMap) {
  return {
    controllers: indexes.controllers.length,
    dialogs: indexes.dialogs.length,
    interfaces: indexes.interfaces.length,
    configTables: indexes.configTables.length,
    callSites: indexes.callSites.length,
    unresolved: indexes.unresolved.length,
    businessNodes: businessMap.nodes.length,
    businessEdges: businessMap.edges.length,
    unclassified: businessMap.statistics.unclassified
  };
}

async function assertSourceUnchanged(input) {
  const current = await readFile(input.sourcePath);
  const sha256 = createHash("sha256").update(current).digest("hex");
  if (current.length !== input.sourceSize || sha256 !== input.sourceSha256) {
    throw new Error(`Client analysis input changed during parse: ${input.sourcePath}`);
  }
}

export async function runClientAnalysis({ rootDir, toolVersion, rebuildExisting = false }) {
  const startedAt = process.hrtime.bigint();
  const input = await readClientInput({ rootDir });
  const parseStartedAt = process.hrtime.bigint();
  const ast = parseJavaScript(input.sourceText);
  const parseDurationMs = elapsedMilliseconds(parseStartedAt);
  const analysisRoot = path.join(rootDir, "client-analysis");

  return publishClientVersion({
    analysisRoot,
    input,
    toolVersion,
    build: async ({ tempDir }) => {
      const generationStartedAt = process.hrtime.bigint();
      const generatedDir = path.join(tempDir, "generated");
      const indexes = await writeGeneratedArtifacts({
        generatedDir,
        source: input.sourceText,
        ast
      });
      const businessMap = await writeBusinessMapArtifacts({
        generatedDir,
        reportsDir: path.join(tempDir, "generated-reports"),
        indexes,
        appVersion: input.appVersion
      });
      await assertSourceUnchanged(input);
      return {
        manifest: {
          performance: {
            parseDurationMs,
            generationDurationMs: elapsedMilliseconds(generationStartedAt),
            totalDurationMs: elapsedMilliseconds(startedAt)
          },
          discoveries: buildDiscoveryCounts(indexes, businessMap)
        }
      };
    },
    rebuildExisting
  });
}

export function parseAnalysisArguments(args) {
  if (args.length === 0) return { rebuildExisting: false };
  if (args.length === 1 && args[0] === "--rebuild-existing-same-source") {
    return { rebuildExisting: true };
  }
  throw new Error(`Unknown client analysis argument: ${args[0]}`);
}
