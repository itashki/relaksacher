/** @file Verify lazy start, idle shutdown and restart of the managed server lifecycle. */
import { expect, test } from "bun:test";
import { createIdleServer } from "../../src/core/media/idle-server.ts";
import { createVideoDescriber } from "../../src/core/media/video-description.ts";

function fixture(failFirst = false) {
  const log: string[] = [];
  let count = 0;
  const lifecycle = createIdleServer({
    idleMs: 20,
    create: () => {
      const id = ++count;
      return {
        async start() {
          log.push(`start${id}`);
          if (failFirst && id === 1) throw new Error("boom");
        },
        async stop() {
          log.push(`stop${id}`);
        },
      };
    },
  });
  return { log, lifecycle };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("server starts lazily, is shared, stops when idle and restarts on demand", async () => {
  const { log, lifecycle } = fixture();
  expect(log).toEqual([]);
  await Promise.all([lifecycle.use(async () => wait(5)), lifecycle.use(async () => 1)]);
  expect(log).toEqual(["start1"]);
  await wait(60);
  expect(log).toEqual(["start1", "stop1"]);
  expect(lifecycle.running()).toBe(false);
  expect(await lifecycle.use(async () => "ok")).toBe("ok");
  expect(log).toEqual(["start1", "stop1", "start2"]);
  await lifecycle.dispose();
  expect(log).toEqual(["start1", "stop1", "start2", "stop2"]);
  await expect(lifecycle.use(async () => 1)).rejects.toThrow("disposed");
});

test("a new job cancels the pending idle shutdown and a failed start is retried", async () => {
  const { log, lifecycle } = fixture(true);
  await expect(lifecycle.use(async () => 1)).rejects.toThrow("boom");
  await lifecycle.use(async () => 1);
  await wait(10);
  await lifecycle.use(async () => 1);
  await wait(10);
  expect(log).not.toContain("stop2");
  await wait(50);
  expect(log).toEqual(["start1", "stop1", "start2", "stop2"]);
});

test("video describer wraps each request in withServer", async () => {
  const events: string[] = [];
  const describer = createVideoDescriber({
    withServer: async (job) => {
      events.push("enter");
      return job();
    },
    fetchImpl: async () => {
      events.push("fetch");
      return Response.json({ description: "a cat" });
    },
  });
  const result = await describer.describe(async () => new Blob(["x"]));
  expect(result.description).toBe("a cat");
  expect(events).toEqual(["enter", "fetch"]);
});
