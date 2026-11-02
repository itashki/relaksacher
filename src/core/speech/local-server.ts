/** @file Own a local speech subprocess, wait for readiness and stop only the server we started. */
import { tmpdir } from "node:os";

type ServerProcess = {
  kill(signal?: number): void;
  exited: Promise<number>;
  exitCode: number | null;
  stdout?: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array>;
};

/** Manage one configured loopback endpoint. Existing healthy servers are reused.
 * The backend command selects its model and available compute device.
 * Custom endpoints remain externally managed. stop() also cancels startup polling. */
export function createLocalSpeechServer({
  url = "http://127.0.0.1:8080/inference",
  command,
  origin = "http://127.0.0.1:8080",
  label = "speech",
  enabled = true,
  startupTimeoutMs = 60000,
  fetchImpl = fetch,
  spawn = (command, options) =>
    Bun.spawn(command, { ...options, stdin: "ignore", stdout: "pipe", stderr: "pipe" }),
}: {
  url?: string;
  command: string[];
  origin?: string;
  label?: string;
  enabled?: boolean;
  startupTimeoutMs?: number;
  fetchImpl?: import("../../types.ts").HttpFetch;
  spawn?: (command: string[], options: { cwd: string }) => ServerProcess;
}) {
  let child: ServerProcess | undefined;
  let stopped = false;
  let startup: Promise<void> | undefined;
  let termination: Promise<void> | undefined;
  const controller = new AbortController();
  const address = new URL(url);
  /** Drain child pipes through console so TUI captures logs; bound incomplete lines.
   * Streaming decoding preserves UTF-8 characters split across process writes. */
  async function forwardLogs(stream: ReadableStream<Uint8Array> | undefined, error: boolean) {
    if (!stream) return;
    let pending = "";
    const decoder = new TextDecoder();
    const emit = (text: string) => {
      if (text.trim()) (error ? console.warn : console.info)(`[${label}] ${text}`);
    };
    try {
      for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = pending.search(/[\r\n]/u)) >= 0) {
          emit(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
        while (pending.length >= 8192) {
          emit(pending.slice(0, 8192));
          pending = pending.slice(8192);
        }
      }
      emit(pending + decoder.decode());
    } catch {
      console.warn(`[${label}] Could not read server output`);
    }
  }
  /** Probe readiness without allowing a stalled health request to block startup or shutdown. */
  async function healthy() {
    try {
      const response = await fetchImpl(new URL("/health", address), {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]),
        redirect: "error",
      });
      return response.ok && (await response.json()).status === "ok";
    } catch {
      return false;
    }
  }
  /** Terminate our child, escalating after one second; never terminate an existing server. */
  function stopChild(): Promise<void> {
    if (!child) return Promise.resolve();
    return (termination ??= (async () => {
      const process = child;
      if (process.exitCode !== null) return;
      process.kill();
      const timer = setTimeout(() => process.kill(9), 1000);
      try {
        await process.exited;
      } finally {
        clearTimeout(timer);
      }
    })());
  }

  return {
    /** Start once and wait for health or reject on early exit, cancellation or deadline. */
    start(): Promise<void> {
      return (startup ??= (async () => {
        if (stopped) throw new Error(`${label} startup cancelled`);
        if (!enabled || address.origin !== origin) return;
        if (await healthy()) return;
        if (stopped) throw new Error(`${label} startup cancelled`);
        // whisper.cpp --convert writes uploads beside its cwd, which may be a read-only checkout.
        // systemd PrivateTmp keeps these temporary voice files inside the service namespace.
        child = spawn(command, { cwd: tmpdir() });
        void forwardLogs(child.stdout, false);
        void forwardLogs(child.stderr, true);
        const deadline = Date.now() + startupTimeoutMs;
        try {
          while (!stopped && Date.now() < deadline) {
            if (child.exitCode !== null)
              throw new Error(`${label} exited with code ${child.exitCode}`);
            if (await healthy()) return;
            await new Promise<void>((resolve) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                resolve();
              };
              const timer = setTimeout(done, 200);
              if (stopped) done();
              else controller.signal.addEventListener("abort", done, { once: true });
            });
          }
          throw new Error(stopped ? `${label} startup cancelled` : `${label} startup timed out`);
        } catch (error) {
          await stopChild();
          throw error;
        }
      })());
    },
    /** Cancel startup and await termination of the owned subprocess. Safe to call repeatedly. */
    async stop() {
      stopped = true;
      controller.abort();
      await stopChild();
    },
  };
}
