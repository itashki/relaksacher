/** @file Regression tests for spontaneous reply sampling and cooldowns. */
import test from "node:test";
import assert from "node:assert/strict";
import { createSpontaneousPolicy } from "../src/core/spontaneous.ts";

const message = { scopeId: "group", roomId: "room", text: "a joke", authorName: "Alice" };

test("spontaneous replies are sampled and cooldown-limited per room", async () => {
  let time = 0;
  let calls = 0;
  const policy = createSpontaneousPolicy({ chance: 1, now: () => time,
    enqueue: (task) => task(), decide: async () => { calls++; return { angle: "joke" }; } });
  assert.ok(await policy(message));
  time = 31000;
  assert.equal(await policy(message), null);
  assert.equal(calls, 1);
  assert.ok(await policy({ ...message, roomId: "other" }));
  time = 300001;
  assert.ok(await policy(message));
});

test("private, disabled, command and unsampled messages never call the model", async () => {
  const base = { enqueue() { assert.fail("must not enqueue"); }, decide() { assert.fail("must not classify"); } };
  assert.equal(await createSpontaneousPolicy({ ...base, enabled: false })(message), null);
  assert.equal(await createSpontaneousPolicy({ ...base, chance: 0 })(message), null);
  assert.equal(await createSpontaneousPolicy(base)({ ...message, scopeId: undefined }), null);
  assert.equal(await createSpontaneousPolicy(base)({ ...message, text: "/search foo" }), null);
});

test("old queued decisions are discarded without interrupting other work", async () => {
  let time = 0;
  const policy = createSpontaneousPolicy({ chance: 1, now: () => time,
    enqueue: async (task) => { time = 61000; return task(); }, decide() { assert.fail("stale message"); } });
  assert.equal(await policy(message), null);
});
