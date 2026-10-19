/** @file Regression tests for spontaneous reply sampling and cooldowns. */
import { expect, test } from "bun:test";
import { createSpontaneousPolicy } from "../src/core/spontaneous.ts";

const message = { scopeId: "group", roomId: "room", text: "a joke", authorName: "Alice" };

test("spontaneous replies are sampled and cooldown-limited per room", async () => {
  let time = 0;
  let calls = 0;
  const policy = createSpontaneousPolicy({
    chance: 1,
    now: () => time,
    enqueue: (task) => task(),
    decide: async () => {
      calls++;
      return { angle: "joke" };
    },
  });
  expect(await policy(message)).toBeTruthy();
  time = 31000;
  expect(await policy(message)).toBe(null);
  expect(calls).toBe(1);
  expect(await policy({ ...message, roomId: "other" })).toBeTruthy();
  time = 300001;
  expect(await policy(message)).toBeTruthy();
});

test("private, disabled, command and unsampled messages never call the model", async () => {
  const base = {
    enqueue() {
      throw new Error("must not enqueue");
    },
    decide() {
      throw new Error("must not classify");
    },
  };
  expect(await createSpontaneousPolicy({ ...base, enabled: false })(message)).toBe(null);
  expect(await createSpontaneousPolicy({ ...base, chance: 0 })(message)).toBe(null);
  expect(await createSpontaneousPolicy(base)({ ...message, scopeId: undefined })).toBe(null);
  expect(await createSpontaneousPolicy(base)({ ...message, text: "/search foo" })).toBe(null);
});

test("old queued decisions are discarded without interrupting other work", async () => {
  let time = 0;
  const policy = createSpontaneousPolicy({
    chance: 1,
    now: () => time,
    enqueue: async (task) => {
      time = 61000;
      return task();
    },
    decide() {
      throw new Error("stale message");
    },
  });
  expect(await policy(message)).toBe(null);
});
