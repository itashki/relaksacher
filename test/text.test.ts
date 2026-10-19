/** @file Regression tests for explicit command parsing. */
import { expect, test } from "bun:test";
import { parseCommands } from "../src/core/text.ts";

test("only think is a command; search remains ordinary text", () => {
  expect(parseCommands("/think explain")).toStrictEqual({
    flags: { think: true },
    content: "explain",
  });
  expect(parseCommands("/search example")).toStrictEqual({
    flags: { think: false },
    content: "/search example",
  });
  expect(parseCommands("https://example.org/think")).toStrictEqual({
    flags: { think: false },
    content: "https://example.org/think",
  });
});
