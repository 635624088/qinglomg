import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseJavaScript, ClientAnalysisSyntaxError } from "../src/parser.mjs";
import { walkJavaScript } from "../src/walk.mjs";
import { formatJavaScript } from "../src/format.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("parses minified JavaScript and walks member calls", async () => {
  const source = await fs.readFile(path.join(here, "fixtures", "minified-sample.js"), "utf8");
  const ast = parseJavaScript(source);
  const calls = [];
  walkJavaScript(ast, { CallExpression(node) { calls.push(node.callee.type); } });
  assert.equal(ast.type, "Program");
  assert.deepEqual(calls, ["MemberExpression", "Identifier"]);
});

test("formats parsed JavaScript into text that reparses", async () => {
  const source = await fs.readFile(path.join(here, "fixtures", "minified-sample.js"), "utf8");
  const formatted = formatJavaScript(parseJavaScript(source));
  assert.match(formatted, /plantBatch/);
  assert.equal(parseJavaScript(formatted).type, "Program");
});

test("reports source position when JavaScript syntax is invalid", () => {
  assert.throws(() => parseJavaScript("const = ;"), (error) => (
    error instanceof ClientAnalysisSyntaxError
    && error.code === "CLIENT_ANALYSIS_SYNTAX_ERROR"
    && Number.isInteger(error.line)
    && Number.isInteger(error.column)
    && Number.isInteger(error.pos)
  ));
});

test("keeps parser dependencies isolated in the tools package", async () => {
  const rootPackage = JSON.parse(await fs.readFile(path.join(here, "..", "..", "..", "package.json"), "utf8"));
  const toolsPackage = JSON.parse(await fs.readFile(path.join(here, "..", "package.json"), "utf8"));
  const parserDependencies = ["acorn", "acorn-walk", "astring"];

  for (const name of parserDependencies) {
    assert.equal(rootPackage.dependencies?.[name], undefined);
    assert.equal(rootPackage.devDependencies?.[name], undefined);
  }

  assert.deepEqual(toolsPackage.dependencies, {
    acorn: "8.17.0",
    "acorn-walk": "8.3.5",
    astring: "1.9.0"
  });
  assert.equal(toolsPackage.engines.node, ">=22");
});
