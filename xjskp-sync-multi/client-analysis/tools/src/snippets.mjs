import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

export function createSnippet({ source, sourceBytes = Buffer.from(source, "utf8"), entry }) {
  const content = sourceBytes.subarray(entry.start, entry.end).toString("utf8");
  const hash = sha256(content);
  return {
    ...entry,
    fileName: `${hash.slice(0, 16)}.js`,
    sha256: hash,
    content
  };
}

export async function writeSnippets({ snippetsDir, source, entries }) {
  await mkdir(snippetsDir, { recursive: true });
  const sourceBytes = Buffer.from(source, "utf8");
  const byFileName = new Map();
  const index = entries.map((entry) => {
    const snippet = createSnippet({ source, sourceBytes, entry });
    byFileName.set(snippet.fileName, snippet.content);
    return {
      name: snippet.name,
      start: snippet.start,
      end: snippet.end,
      fileName: snippet.fileName,
      sha256: snippet.sha256
    };
  });

  await Promise.all([...byFileName].map(([fileName, content]) => writeFile(
    path.join(snippetsDir, fileName),
    content,
    "utf8"
  )));
  await writeFile(path.join(snippetsDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
}
