/** @file Drain accepted work and buffer new events while replacing application code. */

/**
 * Keep transport callbacks alive during a planned restart. Accepted calls finish on
 * the old handler; buffered calls start once, in arrival order, on the replacement.
 * Buffering is in memory and covers planned restarts, not process or machine crashes.
 */
export function createRestartRouter<Event>(initial: (event: Event) => Promise<void>) {
  let handler = initial;
  let paused = false;
  const active = new Set<Promise<void>>();
  const buffered: {
    event: Event;
    resolve: () => void;
    reject: (error: unknown) => void;
  }[] = [];
  const execute = (event: Event) => {
    const task = Promise.resolve().then(() => handler(event));
    active.add(task);
    void task.then(
      () => active.delete(task),
      () => active.delete(task),
    );
    return task;
  };
  return {
    /** Accept an event, retaining its completion promise while a restart buffers it. */
    dispatch(event: Event): Promise<void> {
      if (!paused) return execute(event);
      return new Promise((resolve, reject) => buffered.push({ event, resolve, reject }));
    },
    /** Route a cancellation control to the draining handler without admitting new messages. */
    control: execute,
    pause() {
      paused = true;
    },
    /** Wait for complete adapter delivery, including batching, queued sessions and final edits. */
    async drain() {
      while (active.size) await Promise.allSettled(active);
    },
    /** Atomically install code and release the buffered events; failures remain isolated per event. */
    resume(next = handler) {
      handler = next;
      paused = false;
      for (const entry of buffered.splice(0))
        execute(entry.event).then(entry.resolve, entry.reject);
    },
  };
}

/** Serialize restart requests, keeping old code usable if preparation or replacement fails. */
export function createRestartController<Prepared>({
  prepare,
  router,
  replace,
}: {
  prepare: () => Promise<Prepared>;
  router: Pick<ReturnType<typeof createRestartRouter>, "pause" | "drain" | "resume">;
  replace: (prepared: Prepared) => Promise<void>;
}) {
  let pending: Promise<void> | undefined;
  let closed = false;
  return {
    /** Repeated requests share one restart; preparation happens before incoming work is paused. */
    restart(): Promise<void> {
      if (closed) return Promise.reject(new Error("Application is shutting down"));
      if (pending) return pending;
      pending = (async () => {
        const prepared = await prepare();
        if (closed) return;
        router.pause();
        try {
          await router.drain();
          if (!closed) await replace(prepared);
        } finally {
          if (!closed) router.resume();
        }
      })().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    /** Prevent an in-flight build or drain from installing code during process shutdown. */
    close() {
      closed = true;
    },
  };
}
