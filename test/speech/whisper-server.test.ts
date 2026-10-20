/** @file Check local Whisper startup, readiness, ownership and cancellation. */
import { expect, test } from "bun:test";
import { createWhisperServer } from "../../src/core/speech/whisper-server.ts";

/** Build a controllable child without starting a real model or binding a port. */
function childFixture() {
  let resolve: (code: number) => void;
  const signals: number[] = [];
  const child = {
    exitCode: null as number | null,
    exited: new Promise<number>((done) => {
      resolve = done;
    }),
    kill(signal = 15) {
      signals.push(signal);
      child.exitCode = 0;
      resolve(0);
    },
  };
  return { child, signals };
}

test("healthy existing Whisper is reused and never stopped", async () => {
  const server = createWhisperServer({
    fetchImpl: async () => Response.json({ status: "ok" }),
    spawn: () => {
      throw new Error("Must reuse server");
    },
  });
  await server.start();
  await server.stop();
});

test("starts the requested command, waits for readiness and kills only once", async () => {
  const { child, signals } = childFixture();
  let probes = 0;
  const commands: string[][] = [];
  const server = createWhisperServer({
    model: "/home/ktrd/ai/ggml-small.bin",
    fetchImpl: async () => Response.json({ status: ++probes > 1 ? "ok" : "loading" }),
    spawn: (command) => {
      commands.push(command);
      return child;
    },
  });
  await Promise.all([server.start(), server.start()]);
  expect(commands).toEqual([
    [
      "whisper-server",
      "--host",
      "127.0.0.1",
      "--port",
      "8080",
      "-m",
      "/home/ktrd/ai/ggml-small.bin",
      "--convert",
      "-t",
      "2",
      "-ng",
    ],
  ]);
  await Promise.all([server.stop(), server.stop()]);
  expect(signals).toEqual([15]);
});

test("remote and disabled endpoints do not probe or spawn", async () => {
  for (const options of [{ enabled: false }, { url: "http://remote:8080/inference" }]) {
    const server = createWhisperServer({
      ...options,
      fetchImpl: async () => {
        throw new Error("No probe expected");
      },
      spawn: () => {
        throw new Error("No spawn expected");
      },
    });
    await server.start();
    await server.stop();
  }
});

test("startup deadline cleans up the child and reports failure", async () => {
  const { child, signals } = childFixture();
  const server = createWhisperServer({
    startupTimeoutMs: 0,
    fetchImpl: async () => new Response("", { status: 503 }),
    spawn: () => child,
  });
  await expect(server.start()).rejects.toThrow("timed out");
  expect(signals).toEqual([15]);
});

test("early process exit fails startup", async () => {
  const { child } = childFixture();
  child.exitCode = 1;
  const server = createWhisperServer({
    fetchImpl: async () => new Response("", { status: 503 }),
    spawn: () => child,
  });
  await expect(server.start()).rejects.toThrow("code 1");
});

test("stop cancels readiness polling and terminates the child", async () => {
  const { child, signals } = childFixture();
  let spawned: () => void;
  const ready = new Promise<void>((resolve) => {
    spawned = resolve;
  });
  const server = createWhisperServer({
    fetchImpl: async () => new Response("", { status: 503 }),
    spawn: () => {
      spawned();
      return child;
    },
  });
  const startup = server.start();
  const failure = startup.catch((error: Error) => error);
  await ready;
  await server.stop();
  expect(await failure).toBeInstanceOf(Error);
  expect(((await failure) as Error).message).toContain("cancelled");
  expect(signals).toEqual([15]);
});

test("child output is drained into TUI-compatible console logs with split UTF-8 and bounded lines", async () => {
  const { spyOn } = await import("bun:test");
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const { child } = childFixture();
  let probes = 0;
  const bytes = new TextEncoder().encode("Привет\r\nготово");
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 1));
      controller.enqueue(bytes.slice(1));
      controller.close();
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(20000)));
      controller.close();
    },
  });
  const server = createWhisperServer({
    fetchImpl: async () => Response.json({ status: ++probes > 1 ? "ok" : "loading" }),
    spawn: () => ({ ...child, stdout, stderr }),
  });
  try {
    await server.start();
    for (let i = 0; i < 30 && info.mock.calls.length < 2; i++) await Bun.sleep(1);
    expect(info.mock.calls.map((call) => call[0])).toEqual([
      "[whisper] Привет",
      "[whisper] готово",
    ]);
    expect(warn.mock.calls).toHaveLength(3);
    expect(warn.mock.calls.every((call) => String(call[0]).length <= 8202)).toBe(true);
  } finally {
    await server.stop();
    info.mockRestore();
    warn.mockRestore();
  }
});
