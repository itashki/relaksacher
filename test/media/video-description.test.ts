/** @file Verify the queued SmolVLM2 client with injected fetch and no network. */
import { expect, test } from "bun:test";
import {
  createVideoDescriber,
  unloadOllamaModels,
} from "../../src/core/media/video-description.ts";

const video = () => Promise.resolve(new Blob(["x"]));

test("describes a video and posts multipart file and prompt", async () => {
  let form: FormData | undefined;
  const describer = createVideoDescriber({
    url: "http://127.0.0.1:8083/describe",
    fetchImpl: async (_url, init) => {
      form = init?.body as FormData;
      expect(init?.redirect).toBe("error");
      return Response.json({ description: "  A cat.  ", frames: 4, duration: 2.5 });
    },
  });
  expect(await describer.describe(video, " what? ")).toEqual({
    description: "A cat.",
    frames: 4,
    duration: 2.5,
    model: "SmolVLM2",
  });
  expect(((form as FormData).get("file") as File).name).toBe("video.mp4");
  expect(form?.get("prompt")).toBe("what?");
});

test("rejects empty and oversized videos before any request", async () => {
  const describer = createVideoDescriber({
    fetchImpl: async () => {
      throw new Error("Must not fetch");
    },
  });
  await expect(describer.describe(async () => new Blob([]))).rejects.toThrow("Invalid video size");
  await expect(
    describer.describe(async () => new Blob([new Uint8Array(20 * 1024 * 1024 + 1)])),
  ).rejects.toThrow("Invalid video size");
});

test("rejects non-OK, non-JSON and empty description responses", async () => {
  const responses = [
    new Response("no", { status: 500 }),
    new Response("not json"),
    Response.json({ description: "  " }),
    Response.json({}),
  ];
  const describer = createVideoDescriber({ fetchImpl: async () => responses.shift()! });
  await expect(describer.describe(video)).rejects.toThrow("request failed");
  await expect(describer.describe(video)).rejects.toThrow("no text");
  await expect(describer.describe(video)).rejects.toThrow("no text");
  await expect(describer.describe(video)).rejects.toThrow("no text");
});

test("loads lazily when the job starts and rejects queue overflow", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let loads = 0;
  const describer = createVideoDescriber({
    fetchImpl: async () => {
      await gate;
      return Response.json({ description: "ok" });
    },
  });
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

test("availability is false until set", () => {
  const describer = createVideoDescriber();
  expect(describer.available()).toBe(false);
  describer.setAvailable(true);
  expect(describer.available()).toBe(true);
});

test("unloadOllamaModels unloads every resident model and survives errors", async () => {
  const unloaded: unknown[] = [];
  await unloadOllamaModels({
    ps: async () => ({ models: [{ model: "a" }, { model: "b" }] }),
    generate: async (request) => unloaded.push(request),
  });
  expect(unloaded).toEqual([
    { model: "a", prompt: "", keep_alive: 0 },
    { model: "b", prompt: "", keep_alive: 0 },
  ]);
  await unloadOllamaModels({
    ps: async () => Promise.reject(new Error("down")),
    generate: async () => {},
  });
});
