/** @file Regression tests for explicit command parsing. */
import test from "node:test";
import assert from "node:assert/strict";
import { parseCommands } from "../src/core/text.js";

test("only think is a command; search remains ordinary text", () => {
  assert.deepEqual(parseCommands("/think explain"), { flags: { think: true }, content: "explain" });
  assert.deepEqual(parseCommands("/search example"), { flags: { think: false }, content: "/search example" });
  assert.deepEqual(parseCommands("https://example.org/think"), { flags: { think: false }, content: "https://example.org/think" });
});
