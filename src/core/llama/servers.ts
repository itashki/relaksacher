/** @file Run model server processes one at a time: llama-server or GigaAM, never both resident. */
import { resolvePath } from "../paths.ts";
import { projectDirectory } from "../project.ts";
import { createLocalSpeechServer } from "../speech/local-server.ts";

/** Fixed loopback origin of every llama-server (8080 is Whisper's, 8082 is GigaAM's). */
export const llamaOrigin = "http://127.0.0.1:8084";

/** Key of the GigaAM speech server; llama models are keyed by their GGUF path. */
export const gigaamKey = "gigaam";

/** Minimal server contract: `start()` resolves once ready, `stop()` resolves after the process exited. */
export type IdleManagedServer = { start(): Promise<void>; stop(): Promise<void> };

/** Describe a llama-server for `model` (and optional projector) at context `numCtx`.
 * Values are from the README "Калибровка llama-server" subsection. */
export function createLlamaServer({
  model,
  mmproj,
  numCtx,
  ...options
}: Omit<Parameters<typeof createLocalSpeechServer>[0], "command" | "origin" | "label"> & {
  model: string;
  mmproj?: string;
  numCtx: number;
}) {
  return createLocalSpeechServer({
    url: llamaOrigin,
    startupTimeoutMs: 300000,
    ...options,
    origin: llamaOrigin,
    label: "llama",
    command: [
      "llama-server",
      "-m",
      resolvePath(model, projectDirectory),
      ...(mmproj ? ["--mmproj", resolvePath(mmproj, projectDirectory), "--no-mmproj-offload"] : []),
      "-ngl",
      "99",
      "-fa",
      "on",
      "--jinja",
      "-np",
      "1",
      "-c",
      String(numCtx),
      "--host",
      "127.0.0.1",
      "--port",
      "8084",
      "--video-fps",
      "0.25",
    ],
  });
}

type Entry = {
  key: string;
  job: () => Promise<unknown>;
  settle: (outcome: { value: unknown } | { error: unknown }) => void;
};

/** Serialize jobs through one FIFO lock so at most one model process exists at any time.
 * `use(key, job)` starts `create(key)` if nothing runs, runs the job, then keeps the server only
 * when the next queued job has the same key; otherwise it awaits `stop()` (process exit) first.
 * The caller's promise settles after that decision, so the lock is never free while a process
 * lives. An empty queue unloads at once. A failed start rejects its job and the next one starts
 * fresh. Jobs must not call `use` themselves (deadlock). `dispose()` rejects queued jobs, stops
 * the current server at once, and makes later `use` calls reject.
 * shortcut: a healthy server already on 8084 or 8082 (orphan of a SIGKILLed dev run) is reused
 * whatever its model and is never stopped, so it can sit resident beside the other one; check
 * /props model_path or kill orphans if that ever bites. */
export function createModelServers({ create }: { create: (key: string) => IdleManagedServer }) {
  const queue: Entry[] = [];
  let server: IdleManagedServer | undefined;
  let working = false;
  let disposed = false;

  /** Forget the current server and wait for its process to exit; stop errors are ignored. */
  async function drop() {
    const old = server;
    server = undefined;
    await old?.stop().catch((): void => undefined);
  }

  async function run({ key, job, settle }: Entry) {
    let outcome: Parameters<Entry["settle"]>[0];
    try {
      if (!server) {
        server = create(key);
        try {
          await server.start();
        } catch (error) {
          await drop();
          throw error;
        }
      }
      outcome = { value: await job() };
    } catch (error) {
      outcome = { error };
    }
    if (queue[0]?.key !== key) await drop();
    settle(outcome);
  }

  async function drain() {
    if (working) return;
    working = true;
    for (let entry = queue.shift(); entry; entry = queue.shift()) await run(entry);
    working = false;
  }

  return {
    /** Run `job` with the server for `key` loaded; see the module contract. */
    use<T>(key: string, job: () => Promise<T>): Promise<T> {
      if (disposed) return Promise.reject(new Error("Model servers are disposed"));
      return new Promise<T>((resolve, reject) => {
        queue.push({
          key,
          job,
          settle: (outcome) =>
            "error" in outcome ? reject(outcome.error) : resolve(outcome.value as T),
        });
        void drain();
      });
    },
    /** Reject queued jobs, stop the current server and refuse further jobs. Safe to repeat. */
    async dispose() {
      disposed = true;
      for (const entry of queue.splice(0))
        entry.settle({ error: new Error("Model servers are disposed") });
      await drop();
    },
  };
}
