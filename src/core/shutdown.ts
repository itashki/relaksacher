/** @file Coordinate application cleanup and guarantee a bounded process exit. */

/**
 * Run every cleanup step once, then exit even if unrelated handles remain open.
 * A hard deadline covers stalled websocket handshakes and unfinished HTTP calls.
 * Steps are invoked in order without waiting, so one stalled adapter cannot prevent
 * another adapter from stopping. Inject exit/report hooks for lifecycle tests.
 */
export function createShutdown({
  steps,
  timeoutMs = 2000,
  exit = (code) => process.exit(code),
  report = (message, error) => console.error(message, error ?? ""),
}: {
  steps: (() => unknown)[];
  timeoutMs?: number;
  exit?: (code: number) => void;
  report?: (message: string, error?: unknown) => void;
}) {
  let task: Promise<void> | undefined;
  return {
    get started() {
      return Boolean(task);
    },
    /** Start cleanup or return the existing shutdown; the first exit code wins. */
    run(code = 0): Promise<void> {
      if (task) return task;
      let complete: () => void;
      task = new Promise<void>((resolve) => {
        complete = resolve;
      });
      let finished = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        complete();
        exit(code);
      };
      // Keep this timer referenced: a pending cleanup promise alone cannot keep
      // the process alive long enough to enforce a predictable exit code.
      timer = setTimeout(() => {
        report("Shutdown deadline reached; exiting.");
        finish();
      }, timeoutMs);
      const pending = steps.map((step) => {
        try {
          return Promise.resolve(step());
        } catch (error) {
          return Promise.reject(error);
        }
      });
      void Promise.allSettled(pending).then((results) => {
        if (finished) return;
        for (const result of results) {
          if (result.status === "rejected") report("Shutdown cleanup failed:", result.reason);
        }
        finish();
      });
      return task;
    },
  };
}
