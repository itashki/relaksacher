/** @file Image describer: prompt shape, shared queue ordering, timeout, error mapping. */
import { expect, test } from "bun:test";
import { createRequestQueue } from "../../src/core/queue.ts";
import { createImageDescriber } from "../../src/core/media/image-description.ts";
import { createMediaDescriber } from "../../src/core/media/index.ts";

function fakeStream(chunks: string[], hang = false) {
  let aborted = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  return {
    get aborted() {
      return aborted;
    },
    abort() {
      aborted = true;
      release();
    },
    async *[Symbol.asyncIterator]() {
      for (const content of chunks) yield { message: { content } };
      if (hang) await gate;
    },
  };
}

const make = (chat: (request: any) => Promise<any>, timeoutMs = 1000) => {
  const enqueue = createRequestQueue();
  return {
    enqueue,
    describer: createImageDescriber({
      modelClient: { chat },
      model: "vision",
      timeoutMs,
      runExclusive: (task) => enqueue(task),
    }),
  };
};

test("sends the image without tools and trims streamed text", async () => {
  let request: any;
  const { describer } = make(async (r) => ((request = r), fakeStream([" Кот ", "на диване "])));
  expect(await describer.describeImage("AAA", "что тут?")).toBe("Кот на диване");
  expect(request.tools).toBeUndefined();
  expect(request.stream).toBe(true);
  expect(request.messages[1]).toEqual({ role: "user", content: "что тут?", images: ["AAA"] });
  await make(async (r) => ((request = r), fakeStream(["x"]))).describer.describeImage("B");
  expect(request.messages[1].content).toBe("Подробно опиши изображение.");
});

test("runs after an earlier queued task", async () => {
  const order: string[] = [];
  const { describer, enqueue } = make(async () => (order.push("chat"), fakeStream(["ok"])));
  const first = enqueue(async () => {
    await Bun.sleep(20);
    order.push("first");
  });
  await Promise.all([first, describer.describeImage("A")]);
  expect(order).toEqual(["first", "chat"]);
});

test("aborts the stream on timeout", async () => {
  const stream = fakeStream(["partial"], true);
  const { describer } = make(async () => stream, 20);
  await expect(describer.describeImage("A")).rejects.toThrow("timed out");
  expect(stream.aborted).toBe(true);
});

test("maps vision errors and rejects empty output", async () => {
  const { describer } = make(async () => {
    throw new Error("this model does not support images");
  });
  await expect(describer.describeImage("A")).rejects.toThrow("OLLAMA_VISION_MODEL");
  await expect(make(async () => fakeStream(["  "])).describer.describeImage("A")).rejects.toThrow(
    "no text",
  );
});

test("facade rejects video while unavailable", async () => {
  const media = createMediaDescriber({
    image: { describeImage: async () => "x" },
    video: { available: () => false, describe: async () => ({}) as never },
  });
  expect(media.videoAvailable()).toBe(false);
  await expect(media.describeVideo(async () => new Blob())).rejects.toThrow(
    "Описание видео недоступно.",
  );
  expect(await media.describeImage("A")).toBe("x");
});
