/** @file Verify atomic file replacement leaves only the target file. */
import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { replaceFileAtomically } from "../../src/core/atomic-file.ts";
import { resolvePath } from "../../src/core/paths.ts";
import { temporaryDirectory } from "../support/temp.ts";

test("writes contents without leaving a temporary file", async () => {
  const directory = await temporaryDirectory("atomic-file-");
  const file = resolvePath("data.json", directory);
  await replaceFileAtomically(file, '{"a":1}');
  expect(await Bun.file(file).text()).toBe('{"a":1}');
  expect(await readdir(directory)).toEqual(["data.json"]);
});

test("replaces an existing file", async () => {
  const directory = await temporaryDirectory("atomic-file-");
  const file = resolvePath("data.json", directory);
  await Bun.write(file, "old");
  await replaceFileAtomically(file, "new");
  expect(await Bun.file(file).text()).toBe("new");
  expect(await readdir(directory)).toEqual(["data.json"]);
});

test("creates missing parent directories on request", async () => {
  const directory = await temporaryDirectory("atomic-file-");
  const file = resolvePath("nested/deeper/data.json", directory);
  await replaceFileAtomically(file, "x", { createPath: true });
  expect(await Bun.file(file).text()).toBe("x");
});
