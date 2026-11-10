/** @file Track complete messenger deliveries and drain them before a supervisor-managed restart. */

/** Track handler completion, including batching, queues, tools and final reply delivery. */
export function createRequestLifecycle<Event>(handle: (event: Event) => Promise<void>) {
  const active = new Set<Promise<void>>();
  return {
    /** Admit an event and retain it until all adapter work has completed or failed. */
    dispatch(event: Event) {
      const task = Promise.resolve().then(() => handle(event));
      active.add(task);
      void task.then(
        () => active.delete(task),
        () => active.delete(task),
      );
      return task;
    },
    activeRequests: () => active.size,
    /** Call after stopping intake; await every accepted handler, including failed deliveries. */
    async drain() {
      while (active.size) await Promise.allSettled(active);
    },
  };
}

/** Coalesce restart requests; stop intake and finish accepted work before exiting the process. */
export function createServiceRestart(options: {
  stopReceiving: () => Promise<void>;
  drain: () => Promise<void>;
  shutdown: () => Promise<void>;
}) {
  let pending: Promise<void>;
  return () => {
    pending ??= (async () => {
      await options.stopReceiving();
      await options.drain();
      await options.shutdown();
    })();
    return pending;
  };
}
