/** @file Video description translation: prompt, queue, Russian passthrough and facade fallback. */
import { expect, spyOn, test } from "bun:test";
import { createMediaDescriber } from "../../src/core/media/index.ts";
import { createTranslator } from "../../src/core/media/translate.ts";
import { createRequestQueue } from "../../src/core/queue.ts";

const stream = (text: string) => ({
  abort() {},
  async *[Symbol.asyncIterator]() {
    yield { message: { content: text } };
  },
});

const translator = (chat: (request: any) => Promise<any>) => {
  const enqueue = createRequestQueue();
  return createTranslator({
    modelClient: { chat },
    model: "text-model",
    timeoutMs: 1000,
    runExclusive: (task) => enqueue(task),
  });
};

const english = { description: "A cat.", frames: 4, duration: 3, model: "SmolVLM2" };
const video = { available: () => true, describe: async () => english };
const image = { describeImage: async () => "x" };

test("translator sends the text to the text model without tools and trims the result", async () => {
  let request: any;
  const t = translator(async (r) => ((request = r), stream(" Кошка. ")));
  expect(await t.toRussian("A cat.")).toBe("Кошка.");
  expect(request.model).toBe("text-model");
  expect(request.tools).toBeUndefined();
  expect(request.messages[1]).toEqual({ role: "user", content: "A cat." });
});

test("translator skips Russian text and rejects empty output", async () => {
  let calls = 0;
  const t = translator(async () => (calls++, stream("  ")));
  expect(await t.toRussian("Кошка на диване.")).toBe("Кошка на диване.");
  expect(calls).toBe(0);
  await expect(t.toRussian("A cat.")).rejects.toThrow("no text");
});

test("facade stores a Russian description and an honest model name", async () => {
  const media = createMediaDescriber({
    image,
    video,
    translator: translator(async () => stream("Кошка.")),
  });
  expect(await media.describeVideo(async () => new Blob(["v"]))).toEqual({
    ...english,
    description: "Кошка.",
    model: "SmolVLM2+text-model",
  });
});

test("facade falls back to English with a warning when translation fails", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const media = createMediaDescriber({
    image,
    video,
    translator: translator(async () => {
      throw new Error("ollama down");
    }),
  });
  expect(await media.describeVideo(async () => new Blob(["v"]))).toEqual(english);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("translate: false returns English without touching the model queue", async () => {
  let calls = 0;
  const media = createMediaDescriber({
    image,
    video,
    translator: translator(async () => (calls++, stream("Кошка."))),
  });
  const result = await media.describeVideo(async () => new Blob(["v"]), undefined, {
    translate: false,
  });
  expect(result).toEqual(english);
  expect(calls).toBe(0);
});
