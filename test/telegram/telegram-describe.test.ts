/** @file Telegram `!describe` command: image and video descriptions, caching and routing. */
import { expect, test } from "bun:test";
import { setup } from "../support/telegram-fixture.ts";
import { createVideoDescriptionStore } from "../../src/core/memory/video-descriptions.ts";
import { temporaryDirectory } from "../support/temp.ts";

const chat = { id: 5, type: "supergroup" as const };
const base = {
  chat,
  from: { id: 10, first_name: "Alice" },
  message_thread_id: 7,
  date: 1700000000,
};
const result = { description: "A cat.", frames: 4, duration: 3, model: "SmolVLM2" as const };
const circle = { file_id: "f1", file_unique_id: "u1", length: 240, duration: 5 };

function describer(overrides = {}) {
  const calls = { image: [] as unknown[][], video: [] as unknown[][] };
  return {
    calls,
    describer: {
      describeImage: async (...args: unknown[]) => (calls.image.push(args), "A photo."),
      describeVideo: async (...args: unknown[]) => (calls.video.push(args), result),
      videoAvailable: () => true,
      ...overrides,
    },
  };
}

const sent = (calls: { method: string; payload?: { text?: string } }[]) =>
  calls.filter((call) => call.method === "sendMessage");

test("!describe replying to a photo describes it and replies in the thread", async () => {
  const { describer: d, calls: described } = describer();
  const { bot, calls, inputs } = setup(undefined, undefined, undefined, { describer: d });
  await bot.handleUpdate({
    update_id: 1,
    message: {
      ...base,
      message_id: 2,
      text: "!describe что тут?",
      reply_to_message: { ...base, message_id: 1, photo: [{ file_id: "p1" }] },
    },
  });
  expect(described.image).toStrictEqual([["image:p1", "что тут?"]]);
  const reply = sent(calls)[0].payload as Record<string, unknown>;
  expect(reply.text).toBe("🖼 A photo.");
  expect(reply.message_thread_id).toBe(7);
  expect((reply.reply_parameters as { message_id: number }).message_id).toBe(2);
  expect(inputs).toHaveLength(0);
});

test("!опиши replying to a video stores the entry and reuses it for the same file", async () => {
  const store = createVideoDescriptionStore(await temporaryDirectory("tg-vd-"));
  const { describer: d, calls: described } = describer();
  const { bot, calls, inputs } = setup(undefined, undefined, undefined, {
    describer: d,
    videoDescriptions: store,
    downloadVideo: async () => new Blob(["v"]),
  });
  const update = (id: number) => ({
    update_id: id,
    message: {
      ...base,
      message_id: id,
      text: "!опиши",
      reply_to_message: { ...base, message_id: 1, video_note: circle },
    },
  });
  await bot.handleUpdate(update(2));
  await bot.handleUpdate(update(3));
  expect(described.video).toHaveLength(1);
  expect(sent(calls).map((call) => call.payload.text)).toStrictEqual(["🎬 A cat.", "🎬 A cat."]);
  const saved = await store.get("telegram_5:7", "1");
  expect(saved).toMatchObject({
    kind: "video_note",
    fileUniqueId: "u1",
    durationSec: 5,
    model: "SmolVLM2",
  });
  expect(inputs).toHaveLength(0);
});

test("!describe@otherbot is ignored without a reply", async () => {
  const { describer: d, calls: described } = describer();
  const { bot, calls } = setup(undefined, undefined, undefined, { describer: d });
  await bot.handleUpdate({
    update_id: 1,
    message: { ...base, message_id: 2, text: "!describe@otherbot", photo: [{ file_id: "p" }] },
  });
  expect(sent(calls)).toHaveLength(0);
  expect(described.image).toHaveLength(0);
});

test("!describe without media gives usage and unavailable video gives the unavailable reply", async () => {
  const { describer: d } = describer({ videoAvailable: () => false });
  const { bot, calls } = setup(undefined, undefined, undefined, { describer: d });
  await bot.handleUpdate({
    update_id: 1,
    message: { ...base, message_id: 2, text: "!describe" },
  });
  await bot.handleUpdate({
    update_id: 2,
    message: { ...base, message_id: 4, text: "!describe", video: { ...circle, duration: 3 } },
  });
  expect(sent(calls).map((call) => call.payload.text)).toStrictEqual([
    "Используйте !describe ответом на изображение или видео.",
    "Описание видео недоступно.",
  ]);
});
