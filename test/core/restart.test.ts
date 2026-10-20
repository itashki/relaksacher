/** @file Planned restart coverage: complete old work, retain incoming events, and recover failures. */
import { expect, test } from "bun:test";
import { createRestartController, createRestartRouter } from "../../src/core/restart.ts";

function deferred() {
  let resolve: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

test("restart waits for accepted and queued deliveries, then releases every buffered event once", async () => {
  const generation = deferred(),
    finalEdit = deferred(),
    paused = deferred();
  const events: string[] = [];
  let revision = "old";
  const router = createRestartRouter<string>(async (event) => {
    const owner = revision;
    events.push(`${owner}:${event}:start`);
    if (event === "generating") await generation.promise;
    if (event === "queued") await finalEdit.promise;
    events.push(`${owner}:${event}:end`);
  });
  const active = router.dispatch("generating");
  const queued = router.dispatch("queued");
  const restart = createRestartController({
    prepare: async () => "new",
    router: {
      ...router,
      pause() {
        router.pause();
        paused.resolve();
      },
    },
    replace: async (next) => {
      revision = next;
      events.push("replace");
    },
  });
  const done = restart.restart();
  expect(restart.restart()).toBe(done);
  await paused.promise;
  const arrivals = [router.dispatch("incoming-1"), router.dispatch("incoming-2")];
  generation.resolve();
  await active;
  expect(events).not.toContain("replace");
  expect(events.some((entry) => entry.includes("incoming"))).toBe(false);
  finalEdit.resolve();
  await Promise.all([done, queued, ...arrivals]);
  expect(events).toEqual([
    "old:generating:start",
    "old:queued:start",
    "old:generating:end",
    "old:queued:end",
    "replace",
    "new:incoming-1:start",
    "new:incoming-1:end",
    "new:incoming-2:start",
    "new:incoming-2:end",
  ]);
});

test("cancellation controls reach the draining runtime without releasing new messages", async () => {
  const generation = deferred(),
    paused = deferred();
  const events: string[] = [];
  const router = createRestartRouter<string>(async (event) => {
    events.push(event);
    if (event === "request") await generation.promise;
    if (event === "stop") generation.resolve();
  });
  const active = router.dispatch("request");
  const restart = createRestartController({
    prepare: async () => {},
    router: {
      ...router,
      pause() {
        router.pause();
        paused.resolve();
      },
    },
    replace: async () => {
      events.push("replace");
    },
  });
  const pending = restart.restart();
  await paused.promise;
  const next = router.dispatch("next");
  await router.control("stop");
  await Promise.all([active, pending, next]);
  expect(events).toEqual(["request", "stop", "replace", "next"]);
});

test("failed preparation keeps receiving on old code; failed replacement releases buffered work", async () => {
  const received: number[] = [];
  const router = createRestartRouter<number>(async (event) => {
    received.push(event);
  });
  let failBuild = true;
  const restart = createRestartController({
    router,
    prepare: async () => {
      if (failBuild) throw new Error("bad build");
    },
    replace: async () => {
      void router.dispatch(2);
      throw new Error("bad replacement");
    },
  });
  await expect(restart.restart()).rejects.toThrow("bad build");
  await router.dispatch(1);
  failBuild = false;
  await expect(restart.restart()).rejects.toThrow("bad replacement");
  await router.dispatch(3);
  expect(received).toEqual([1, 2, 3]);
});

test("shutdown during preparation or drain cannot install a replacement", async () => {
  for (const duringDrain of [false, true]) {
    const blocked = deferred(),
      entered = deferred();
    let replaced = false;
    const router = createRestartRouter(async () => {
      entered.resolve();
      await blocked.promise;
    });
    const active = duringDrain ? router.dispatch(undefined) : Promise.resolve();
    const restart = createRestartController({
      router,
      prepare: async () => {
        if (!duringDrain) {
          entered.resolve();
          await blocked.promise;
        }
      },
      replace: async () => {
        replaced = true;
      },
    });
    const pending = restart.restart();
    await entered.promise;
    restart.close();
    blocked.resolve();
    await Promise.all([pending, active]);
    expect(replaced).toBe(false);
    await expect(restart.restart()).rejects.toThrow("shutting down");
  }
});
