/** @file Verify the queued video describer with a fake model client and no server. */
import { expect, test } from "bun:test";
import { createVideoDescriber } from "../../src/core/media/video-description.ts";

const video = () => Promise.resolve(new Blob(["x"]));
const stream = (text: string, onAbort = () => {}) => ({
  abort: onAbort,
  async *[Symbol.asyncIterator]() {
    yield { message: { content: text } };
  },
});
const make = (chat: (request: any) => Promise<any>, timeoutMs = 1000, available = true) =>
  createVideoDescriber({ modelClient: { chat }, model: "vision", timeoutMs, available });

test("sends the clip as a base64 video, tool-free, with a Russian prompt", async () => {
  let request: any;
  const describer = make(async (r) => ((request = r), stream("  Кот.  ")));
  expect(await describer.describe(video, " что? ")).toEqual({
    description: "Кот.",
    model: "vision",
  });
  expect(request.model).toBe("vision");
  expect(request.tools).toBeUndefined();
  expect(request.messages[0].content).toMatch(/на русском языке/);
  expect(request.messages[1]).toEqual({ role: "user", content: "что?", videos: [btoa("x")] });
  await describer.describe(video);
  expect(request.messages[1].content).toBe("Подробно опиши это видео.");
});

test("rejects empty and oversized videos before any request", async () => {
  const describer = make(async () => {
    throw new Error("Must not chat");
  });
  await expect(describer.describe(async () => new Blob([]))).rejects.toThrow("Invalid video size");
  await expect(
    describer.describe(async () => new Blob([new Uint8Array(20 * 1024 * 1024 + 1)])),
  ).rejects.toThrow("Invalid video size");
});

test("rejects empty output", async () => {
  await expect(make(async () => stream("  ")).describe(video)).rejects.toThrow("no text");
});

test("timeout aborts the stream, including one that arrives after the timer fired", async () => {
  let aborted = 0;
  const late = make(async () => (await Bun.sleep(30), stream("late", () => aborted++)), 5);
  await expect(late.describe(video)).rejects.toThrow("timed out");
  expect(aborted).toBe(1);
});

test("loads lazily when the job starts and rejects queue overflow", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let loads = 0;
  const describer = make(async () => (await gate, stream("ok")));
  const load = () => {
    loads++;
    return video();
  };
  const jobs = Array.from({ length: 11 }, () => describer.describe(load));
  await Bun.sleep(0);
  expect(loads).toBe(1);
  await expect(describer.describe(load)).rejects.toThrow("queue is full");
  release();
  await Promise.all(jobs);
  expect(loads).toBe(11);
});

test("availability is the construction flag", () => {
  expect(make(async () => stream("x"), 1, false).available()).toBe(false);
  expect(make(async () => stream("x")).available()).toBe(true);
});
