import test from "node:test";
import assert from "node:assert/strict";

import {
  formatAllowedHostsInput,
  parseAllowedHostsInput,
} from "./system/public/allowed-hosts-view.js";

test("allowed hosts view parses a comma separated host list", () => {
  assert.deepEqual(
    parseAllowedHostsInput("100.66.1.2, 100.66.1.3"),
    ["100.66.1.2", "100.66.1.3"],
  );
});

test("allowed hosts view trims, lowercases, drops empties, and deduplicates", () => {
  assert.deepEqual(
    parseAllowedHostsInput(" 100.66.1.2 , 100.66.1.2 ,  ,MY-HOST:8080"),
    ["100.66.1.2", "my-host:8080"],
  );
});

test("allowed hosts view treats blank input as an empty list", () => {
  assert.deepEqual(parseAllowedHostsInput(""), []);
  assert.deepEqual(parseAllowedHostsInput("  ,  "), []);
  assert.deepEqual(parseAllowedHostsInput(null), []);
  assert.deepEqual(parseAllowedHostsInput(undefined), []);
});

test("allowed hosts view keeps a single entry and newline separated entries", () => {
  assert.deepEqual(parseAllowedHostsInput("100.66.1.2"), ["100.66.1.2"]);
  assert.deepEqual(
    parseAllowedHostsInput("100.66.1.2\n100.66.1.3"),
    ["100.66.1.2", "100.66.1.3"],
  );
});

test("allowed hosts view formats a host list back to a comma separated string", () => {
  assert.equal(formatAllowedHostsInput(["100.66.1.2", "100.66.1.3"]), "100.66.1.2, 100.66.1.3");
  assert.equal(formatAllowedHostsInput([]), "");
  assert.equal(formatAllowedHostsInput(null), "");
  assert.equal(formatAllowedHostsInput(undefined), "");
  assert.equal(formatAllowedHostsInput(["100.66.1.2"]), "100.66.1.2");
});
