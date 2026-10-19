/** @file Regression coverage for memory behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { temporaryDirectory } from "./temp.ts";
import { resolvePath } from "../src/core/paths.ts";
import { createMemoryStore } from "../src/core/memory.ts";

test("memory survives reloads, serializes concurrent writes, and isolates scopes", async () => {
  const directory = await temporaryDirectory("relaksacher-test-");
  const memory = createMemoryStore(directory);
  await Promise.all([
    memory.addMemoryFact("123", "first fact", "Alice"),
    memory.addMemoryFact("123", "second fact", "Bob"),
    memory.addMemoryFact("456", "other scope", "Carol"),
  ]);
  const reloaded = createMemoryStore(directory);
  expect((await reloaded.loadMemory("123")).map((f) => f.fact)).toStrictEqual([
    "first fact",
    "second fact",
  ]);
  expect((await reloaded.loadMemory("456")).length).toBe(1);
  await memory.addMemoryFact("123", "FIRST FACT", "Alice");
  expect((await memory.loadMemory("123")).length).toBe(2);
  await memory.removeMemoryFact("123", 1);
  expect((await memory.loadMemory("123")).map((f) => f.id)).toStrictEqual([2]);
  await expect(memory.addMemoryFact("../escape", "fact", "Alice")).rejects.toThrow();
});

test("Bun writes create a new nested memory directory", async () => {
  const directory = await temporaryDirectory("relaksacher-memory-");
  const store = createMemoryStore(resolvePath("new/nested#memory", directory));
  await store.addMemoryFact("123", "persistent fact", "Alice");
  expect((await store.loadMemory("123")).map((entry) => entry.fact)).toEqual(["persistent fact"]);
});
