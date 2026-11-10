/** @file Full service restart drains work without cancelling replies or starting duplicate exits. */
import { expect, test } from "bun:test";
import { createRequestLifecycle, createServiceRestart } from "../../src/core/service-restart.ts";

test("activity covers pending deliveries and is cleared on success and failure", async () => {
  const delivery = Promise.withResolvers<void>();
  const lifecycle = createRequestLifecycle(async (fail: boolean) => {
    await delivery.promise;
    if (fail) throw new Error("delivery failed");
  });
  const outcomes = Promise.allSettled([lifecycle.dispatch(false), lifecycle.dispatch(true)]);
  expect(lifecycle.activeRequests()).toBe(2);
  let drained = false;
  const drain = lifecycle.drain().then(() => {
    drained = true;
  });
  await Bun.sleep(0);
  expect(drained).toBe(false);
  delivery.resolve();
  expect((await outcomes).map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  await drain;
  expect(lifecycle.activeRequests()).toBe(0);
});

test("restart stops intake first and coalesces repeated commands while draining", async () => {
  const stopped = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const events: string[] = [];
  const restart = createServiceRestart({
    stopReceiving: async () => {
      events.push("stop intake");
      await stopped.promise;
    },
    drain: async () => {
      events.push("drain");
      await finished.promise;
    },
    shutdown: async () => {
      events.push("exit");
    },
  });
  const pending = restart();
  expect(restart()).toBe(pending);
  expect(events).toEqual(["stop intake"]);
  stopped.resolve();
  await Bun.sleep(0);
  expect(events).toEqual(["stop intake", "drain"]);
  finished.resolve();
  await pending;
  expect(events).toEqual(["stop intake", "drain", "exit"]);
  expect(restart()).toBe(pending);
});
