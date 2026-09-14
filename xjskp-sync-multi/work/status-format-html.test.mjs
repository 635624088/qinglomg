import assert from "node:assert/strict";
import test from "node:test";

import {
  escHtml,
  formatMaturitySeconds,
  formatPlainSeconds,
  mdCell,
} from "./status-format-html.mjs";

test("escHtml and mdCell preserve the existing status document escaping contract", () => {
  assert.equal(escHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.equal(escHtml(null), "");
  assert.equal(mdCell("a|b\r\nc"), "a\\|b c");
  assert.equal(mdCell(undefined), "");
});

test("second formatters preserve maturity and plain zero semantics", () => {
  assert.equal(formatMaturitySeconds(null), "-");
  assert.equal(formatMaturitySeconds(0), "可收获");
  assert.equal(formatMaturitySeconds(61), "1分01秒");
  assert.equal(formatPlainSeconds(Number.NaN), "-");
  assert.equal(formatPlainSeconds(0), "0秒");
  assert.equal(formatPlainSeconds(61), "1分01秒");
});

