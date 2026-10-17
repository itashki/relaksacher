import test from "node:test";
import assert from "node:assert/strict";
import { createRequestQueue } from "../src/core/queue.js";

test("requests run one at a time in arrival order and report waiting positions", async () => {
  const queue = createRequestQueue();
  const events = [];
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const first = queue(async () => { events.push("first"); await blocked; });
  const second = queue(async () => events.push("second"), async (position) => events.push(`Bob:${position}`));
  const third = queue(async () => events.push("third"), async (position) => events.push(`Alice:${position}`));
  await Promise.resolve();
  assert.ok(events.includes("Bob:1"));
  assert.ok(events.includes("Alice:2"));
  assert.ok(!events.includes("second"));
  release();
  await Promise.all([first, second, third]);
  assert.deepEqual(events.filter((value) => !value.includes(":")), ["first", "second", "third"]);
});

test("failed requests and failed notifications do not block the queue", async (t) => {
  t.mock.method(console, "error", () => {});
  const queue = createRequestQueue();
  const first = queue(async () => { throw new Error("generation failed"); });
  const second = queue(async () => "completed", async () => { throw new Error("delivery failed"); });
  await assert.rejects(first, /generation failed/);
  assert.equal(await second, "completed");
  assert.equal(await queue(async () => "next"), "next");
});
