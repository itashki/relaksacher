/** @file Regression tests for memory.test. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemoryStore } from "../src/core/memory.js";

test("memory survives reloads, serializes concurrent writes, and isolates scopes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "relaksacher-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const memory = createMemoryStore(directory);
  await Promise.all([
    memory.addMemoryFact("123", "first fact", "Alice"),
    memory.addMemoryFact("123", "second fact", "Bob"),
    memory.addMemoryFact("456", "other scope", "Carol"),
  ]);
  const reloaded = createMemoryStore(directory);
  assert.deepEqual((await reloaded.loadMemory("123")).map((f) => f.fact), ["first fact", "second fact"]);
  assert.equal((await reloaded.loadMemory("456")).length, 1);
  await memory.addMemoryFact("123", "FIRST FACT", "Alice");
  assert.equal((await memory.loadMemory("123")).length, 2);
  await memory.removeMemoryFact("123", 1);
  assert.deepEqual((await memory.loadMemory("123")).map((f) => f.id), [2]);
  await assert.rejects(memory.addMemoryFact("../escape", "fact", "Alice"));
});
