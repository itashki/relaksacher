/** @file Run bounded metadata extraction and cancellable audio pipes using Bun subprocesses. */
import { Readable } from "node:stream";

/** Bounded metadata output; cancellation and deadlines kill the child process. */
export async function runMusicCommand(
  cmd: string[],
  {
    signal,
    timeout = 45_000,
    maxBuffer = 4 * 1024 * 1024,
  }: { signal?: AbortSignal; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  signal?.throwIfAborted();
  const child = Bun.spawn(cmd, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    signal,
    timeout,
    maxBuffer,
    killSignal: "SIGKILL",
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let size = 0,
    text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBuffer) throw new Error("Music command output limit exceeded");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    if ((await child.exited) !== 0) throw new Error("Music command failed or timed out");
    signal?.throwIfAborted();
    return text;
  } finally {
    child.kill("SIGKILL");
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await child.exited;
  }
}

/** Native Web Stream pipe, adapted to a Node stream only at the Discord boundary. */
export function createMusicPipeline(
  sourceCmd: string[],
  encoderCmd: string[],
  onFailure: () => void,
) {
  const source = Bun.spawn(sourceCmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  let encoder: ReturnType<typeof spawnEncoder>;
  /** Start the encoder with the source Web Stream as stdin; preserve native stream backpressure. */
  function spawnEncoder() {
    return Bun.spawn(encoderCmd, { stdin: source.stdout, stdout: "pipe", stderr: "ignore" });
  }
  try {
    encoder = spawnEncoder();
  } catch (error) {
    source.kill("SIGKILL");
    throw error;
  }
  const stream = Readable.from(encoder.stdout, { objectMode: false });
  let stopped = false;
  /** Idempotently terminate both subprocesses and destroy the Discord-facing readable stream. */
  function stop() {
    if (stopped) return;
    stopped = true;
    source.kill("SIGKILL");
    encoder.kill("SIGKILL");
    stream.destroy();
  }
  /** Stop the pipeline and notify its owner once; intentional cleanup never reports playback failure. */
  function fail() {
    if (stopped) return;
    stop();
    onFailure();
  }
  stream.on("error", fail);
  for (const child of [source, encoder]) {
    void child.exited.then((code) => {
      if (code !== 0) fail();
    }, fail);
  }
  return { stream, stop, exited: Promise.all([source.exited, encoder.exited]) };
}
