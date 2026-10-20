/** @file Regression coverage for music process behavior and its external boundaries. */
import { expect, test } from "bun:test";
import { createMusicPipeline, runMusicCommand } from "../../src/adapters/music/process.ts";

const command = (script: string) => [Bun.argv[0], "-e", script];
const passthrough = command("await Bun.write(Bun.stdout, await Bun.stdin.bytes())");

test("Bun music commands collect stdout and reject failures, large output and deadlines", async () => {
  expect(await runMusicCommand(command('console.log("Музыка")'))).toBe("Музыка\n");
  await expect(runMusicCommand(command("process.exit(2)"))).rejects.toThrow();
  await expect(
    runMusicCommand(command('console.log("a".repeat(4096))'), { maxBuffer: 32 }),
  ).rejects.toThrow();
  await expect(
    runMusicCommand(command("setInterval(() => {}, 1000)"), { timeout: 40 }),
  ).rejects.toThrow();
  await expect(runMusicCommand(["/tmp/relaksacher-missing-command"])).rejects.toThrow();
});

test("Bun music commands respect cancellation before and during execution", async () => {
  const before = new AbortController();
  before.abort();
  await expect(
    runMusicCommand(command('console.log("unused")'), { signal: before.signal }),
  ).rejects.toThrow();
  const during = new AbortController();
  const running = runMusicCommand(command("setInterval(() => {}, 1000)"), {
    signal: during.signal,
  });
  const timer = setTimeout(() => during.abort(), 40);
  try {
    await expect(running).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
});

test("Bun music pipeline streams binary bytes through both children", async () => {
  let errors = 0;
  const size = 2 * 1024 * 1024;
  const pipeline = createMusicPipeline(
    command(`await Bun.write(Bun.stdout, new Uint8Array(${size}).fill(137))`),
    passthrough,
    () => {
      errors++;
    },
  );
  try {
    const chunks: Uint8Array[] = [];
    for await (const chunk of pipeline.stream) chunks.push(new Uint8Array(chunk));
    expect(await pipeline.exited).toEqual([0, 0]);
    const output = new Uint8Array(Bun.concatArrayBuffers(chunks));
    expect(output.length).toBe(size);
    expect(output.every((value) => value === 137)).toBe(true);
    expect(errors).toBe(0);
  } finally {
    pipeline.stop();
  }
});

test("Bun pipeline failure notifies once and stops its sibling process", async () => {
  for (const failSource of [true, false]) {
    let errors = 0;
    const idle = command("setInterval(() => {}, 1000)");
    const fail = command("process.exit(3)");
    const pipeline = createMusicPipeline(failSource ? fail : idle, failSource ? idle : fail, () => {
      errors++;
    });
    try {
      const result = await Promise.race([
        pipeline.exited,
        Bun.sleep(500).then(() => "still-running"),
      ]);
      expect(result).not.toBe("still-running");
      await Bun.sleep(10);
      expect(errors).toBe(1);
    } finally {
      pipeline.stop();
    }
  }
});

test("stopping a Bun pipeline terminates both children without reporting playback failure", async () => {
  let errors = 0;
  const pipeline = createMusicPipeline(command("setInterval(() => {}, 1000)"), passthrough, () => {
    errors++;
  });
  pipeline.stop();
  pipeline.stop();
  expect(
    await Promise.race([pipeline.exited, Bun.sleep(500).then(() => "still-running")]),
  ).not.toBe("still-running");
  expect(errors).toBe(0);
});

test("audio EOF waits for source failure and empty output never completes successfully", async () => {
  for (const script of [
    "await Bun.stdout.writer().end(); await Bun.sleep(50); process.exit(1)",
    "process.exit(0)",
  ]) {
    let failures = 0;
    let completed = false;
    const pipeline = createMusicPipeline(command(script), passthrough, () => {
      expect(completed).toBe(false);
      failures++;
    });
    try {
      try {
        for await (const _chunk of pipeline.stream) {
          // Drain the stream exactly as the audio player would.
        }
        completed = true;
      } catch {
        // Failure destroys the Discord-facing stream before it can signal natural completion.
      }
      await pipeline.exited;
      expect(failures).toBe(1);
    } finally {
      pipeline.stop();
    }
  }
});

test("Bun pipeline reports launch errors synchronously", () => {
  expect(() =>
    createMusicPipeline(["/tmp/relaksacher-missing-command"], passthrough, () => {}),
  ).toThrow();
  expect(() =>
    createMusicPipeline(
      command("setInterval(() => {}, 1000)"),
      ["/tmp/relaksacher-missing-command"],
      () => {},
    ),
  ).toThrow();
});

test.skipIf(!Bun.which("ffmpeg"))("Bun pipeline passes PCM audio through real FFmpeg", async () => {
  let errors = 0;
  const bytes = 19_200;
  const pipeline = createMusicPipeline(
    command(`await Bun.write(Bun.stdout, new Uint8Array(${bytes}))`),
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "2",
      "pipe:1",
    ],
    () => {
      errors++;
    },
  );
  try {
    let size = 0;
    for await (const chunk of pipeline.stream) size += chunk.length;
    expect(size).toBe(bytes);
    expect(await pipeline.exited).toEqual([0, 0]);
    expect(errors).toBe(0);
  } finally {
    pipeline.stop();
  }
});
