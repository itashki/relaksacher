/** @file Regression coverage for queue behavior and its external boundaries. */
import { spyOn, expect, test, onTestFinished } from "bun:test";
import { createRequestQueue } from "../../src/core/queue.ts";

test("requests run one at a time in arrival order and report waiting positions", async () => {
  const queue = createRequestQueue();
  const events: string[] = [];
  let release: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue(async () => {
    events.push("first");
    await blocked;
  });
  const second = queue(
    async () => events.push("second"),
    async (position) => {
      events.push(`Bob:${position}`);
    },
  );
  const third = queue(
    async () => events.push("third"),
    async (position) => {
      events.push(`Alice:${position}`);
    },
  );
  await Promise.resolve();
  expect(events.includes("Bob:1")).toBeTruthy();
  expect(events.includes("Alice:2")).toBeTruthy();
  expect(!events.includes("second")).toBeTruthy();
  release();
  await Promise.all([first, second, third]);
  expect(events.filter((value) => !value.includes(":"))).toStrictEqual([
    "first",
    "second",
    "third",
  ]);
});

test("failed requests and failed notifications do not block the queue", async () => {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  const queue = createRequestQueue();
  const first = queue(async () => {
    throw new Error("generation failed");
  });
  const second = queue(
    async () => "completed",
    async () => {
      throw new Error("delivery failed");
    },
  );
  await expect(first).rejects.toThrow(/generation failed/);
  expect(await second).toBe("completed");
  expect(await queue(async () => "next")).toBe("next");
});
