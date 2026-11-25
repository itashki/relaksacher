/** @file Coverage for the Discord !describe command. */
import { expect, test, onTestFinished } from "bun:test";
import { Events } from "discord.js";
import type { ClientUser } from "discord.js";
import { createDiscordBot, fixture } from "../support/fixtures.ts";
import type { MediaDescriber } from "../../src/core/media/index.ts";

function setup(options: { video?: boolean; store?: Record<string, unknown> } = {}) {
  const calls: string[] = [];
  const replies: string[] = [];
  let sessions = 0;
  const describer = {
    describeImage: async (base64: string, question?: string) => {
      calls.push(`image:${base64}:${question ?? ""}`);
      return "a cat";
    },
    describeVideo: async (load: () => Promise<Blob>) => {
      await load();
      calls.push("video");
      return { description: "a dog", model: "vision-model" };
    },
    videoAvailable: () => options.video ?? true,
  } as MediaDescriber;
  const saved: unknown[] = [];
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession() {
        sessions++;
        return { stop() {}, async run() {} };
      },
    },
    describer,
    videoDescriptions: fixture({
      findByFile: async () => null,
      save: async (_chat: string, entry: unknown) => saved.push(entry),
      ...options.store,
    }),
    loadImage: async (url: string) => `img(${url})`,
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const send = (message: Record<string, unknown>) =>
    bot.client.listeners(Events.MessageCreate)[0]({
      id: "m1",
      guild: { id: "g" },
      channel: { id: "chan", isThread: () => false },
      author: { id: "u", username: "Alice", bot: false },
      mentions: { has: () => false },
      attachments: new Map(),
      reply: async (payload: { content: string }) => {
        replies.push(payload.content);
        return { id: "r" };
      },
      ...message,
    });
  return { send, calls, replies, saved, sessions: () => sessions };
}

const photo = new Map([
  ["1", { id: "1", url: "https://cdn.discordapp.com/a.png", contentType: "image/png", size: 5 }],
]);
const clip = new Map([
  ["2", { id: "2", url: "https://cdn.discordapp.com/a.mp4", contentType: "video/mp4", size: 5 }],
]);

test("!describe on an image attachment describes it and creates no session", async () => {
  const { send, calls, replies, sessions } = setup();
  await send({ content: "!describe что тут?", attachments: photo });
  expect(calls).toEqual(["image:img(https://cdn.discordapp.com/a.png):что тут?"]);
  expect(replies).toEqual(["🖼 a cat"]);
  expect(sessions()).toBe(0);
});

test("!describe replying to a video stores the entry under the channel chat id", async () => {
  const { send, calls, replies, saved } = setup();
  const loaded: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    loaded.push(String(url));
    return new Response(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]));
  }) as unknown as typeof fetch;
  onTestFinished(() => {
    globalThis.fetch = original;
  });
  await send({
    content: "!опиши",
    reference: { messageId: "v1" },
    fetchReference: async () => ({
      id: "v1",
      attachments: clip,
      author: { id: "u2", username: "Bob" },
    }),
  });
  expect(calls).toEqual(["video"]);
  expect(replies).toEqual(["🎬 a dog"]);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ messageId: "v1", fileUniqueId: "2", kind: "video" });
  expect(loaded).toEqual(["https://cdn.discordapp.com/a.mp4"]);
});

test("!describe without media gives the usage reply", async () => {
  const { send, replies, sessions } = setup();
  await send({ content: "!describe" });
  expect(replies).toEqual(["Используйте !describe ответом на изображение или видео."]);
  expect(sessions()).toBe(0);
});

test("!describe on a video says it is unavailable when the backend is down", async () => {
  const { send, calls, replies } = setup({ video: false });
  await send({ content: "!describe", attachments: clip });
  expect(calls).toEqual([]);
  expect(replies).toEqual(["Описание видео недоступно."]);
});
