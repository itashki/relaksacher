/** @file Start a restartable local server on first use and stop it after an idle period. */

/** Minimal server contract: `start()` resolves once ready, `stop()` ends only our child. */
export type IdleManagedServer = { start(): Promise<void>; stop(): Promise<void> };

/** Run jobs against a server created on demand by `create`.
 * `use(job)` starts a fresh server if none is running (concurrent callers share one startup),
 * runs the job, and keeps the server alive while any job is active. When the last job ends,
 * a timer of `idleMs` is armed; if no job begins before it fires, the server is stopped and
 * dropped so that its memory is returned to the system. The next `use` creates a new server.
 * A failed startup drops that server so the next call retries. `dispose()` cancels the timer
 * and stops the server; later `use` calls reject. */
export function createIdleServer({
  create,
  idleMs = 300000,
}: {
  create: () => IdleManagedServer;
  idleMs?: number;
}) {
  let server: IdleManagedServer | undefined;
  let ready: Promise<void> | undefined;
  let active = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let stopping: Promise<void> = Promise.resolve();

  /** Stop and forget the current server; a following start waits for this to finish. */
  function discard() {
    const old = server;
    server = undefined;
    ready = undefined;
    if (!old) return;
    stopping = stopping.then((): Promise<void> => old.stop()).catch((): void => undefined);
  }

  return {
    /** True while a server instance exists (starting or running). */
    running: () => server !== undefined,
    /** Ensure the server is ready, run `job`, then schedule idle shutdown. */
    async use<T>(job: () => Promise<T>): Promise<T> {
      if (disposed) throw new Error("Server lifecycle is disposed");
      clearTimeout(timer);
      timer = undefined;
      active++;
      try {
        await stopping;
        if (!server) {
          const created = create();
          server = created;
          ready = created.start().catch((error) => {
            if (server === created) discard();
            throw error;
          });
        }
        await ready;
        return await job();
      } finally {
        active--;
        if (active === 0 && server && !disposed) {
          timer = setTimeout(() => {
            timer = undefined;
            if (active === 0) discard();
          }, idleMs);
          // An idle timer alone must not keep the process alive.
          (timer as { unref?: () => void }).unref?.();
        }
      }
    },
    /** Cancel the idle timer, stop the server and refuse further jobs. Safe to repeat. */
    async dispose() {
      disposed = true;
      clearTimeout(timer);
      timer = undefined;
      discard();
      await stopping;
    },
  };
}
