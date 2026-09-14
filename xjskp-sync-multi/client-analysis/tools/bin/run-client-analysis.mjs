import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAnalysisArguments, runClientAnalysis } from "../src/run.mjs";
import packageInfo from "../package.json" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..", "..", "..");
const toolVersion = packageInfo.version;

try {
  const options = parseAnalysisArguments(process.argv.slice(2));
  const result = await runClientAnalysis({ rootDir, toolVersion, ...options });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    appVersion: result.manifest.appVersion,
    sourceSha256: result.manifest.sourceSha256,
    versionDir: result.versionDir,
    performance: result.manifest.performance,
    discoveries: result.manifest.discoveries,
    ...(result.backupDir === undefined ? {} : { backupDir: result.backupDir })
  }, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
}
