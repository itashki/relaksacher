/** @file Regression coverage for paths behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { resolvePath } from "../src/core/paths.ts";

test("filesystem paths resolve without requiring an existing destination", () => {
  const base = Bun.fileURLToPath(new URL("../", import.meta.url));
  expect(resolvePath("new-memory/scope.json", base)).toBe(`${base}new-memory/scope.json`);
  expect(resolvePath("./memory/../new-memory/scope.json", base)).toBe(
    `${base}new-memory/scope.json`,
  );
  expect(resolvePath(`${base}new-memory/scope.json`, "/elsewhere")).toBe(
    `${base}new-memory/scope.json`,
  );
});

test("filesystem path punctuation is preserved literally", () => {
  const base = Bun.fileURLToPath(new URL("../", import.meta.url));
  for (const name of ["some directory", "hash#", "query?", "percent%20", "русский"])
    expect(resolvePath(`${name}/scope.json`, base)).toBe(`${base}${name}/scope.json`);
});
