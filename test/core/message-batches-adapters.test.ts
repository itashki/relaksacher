/** @file Verify grouped requests, reply-based speech and command continuations on both messengers. */
import { expect, test, onTestFinished } from "bun:test";
import { Events, type ClientUser } from "discord.js";
import {
  createDiscordBot,
  createTelegramBot,
  fixture,
  type TestSessionOptions,
} from "../support/fixtures.ts";

const recording = () => ({ audio: new Blob(["OggS"]), duration: 1, waveform: "AA==" });

test("Discord joins addressed requests and speech continuations, and expands replies to any burst member", async () => {
  const requests: TestSessionOptions[] = [];
  const voices: string[] = [];
  const bot = createDiscordBot({
    config: { messageBatchWindowMs: 15 },
    assistant: {
      createSession(options) {
        requests.push(options);
        return { stop() {}, run: async () => ({ text: "" }) };
      },
    },
    generateVoice: async (text) => {
      voices.push(text);
      return recording();
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const handle = bot.client.listeners(Events.MessageCreate)[0];
  const message = (id: string, content: string, mentioned = false) => ({
    id,
    content,
    author: { id: "alice", username: "Alice" },
    channelId: "room",
    channel: { id: "room", isThread: () => false },
    mentions: { has: () => mentioned },
    reply: async () => ({ id: "out" }),
  });
  const first = message("1", "<@bot> Первая часть", true);
  const second = message("2", "Вторая часть");
  await Promise.all([handle(first), handle(second)]);
  expect(requests).toHaveLength(1);
  expect(requests[0].conversation.at(-1).content).toContain("Первая часть\nВторая часть");
  await handle({
    ...message("3", "!voice"),
    reference: { messageId: "2" },
    fetchReference: async () => second,
  });
  expect(voices).toEqual(["<@bot> Первая часть\nВторая часть"]);
  await Promise.all([
    handle(message("4", "!voice --speaker aidar Начало")),
    handle(message("5", "Продолжение")),
  ]);
  expect(voices.at(-1)).toBe("Начало\nПродолжение");
  expect(requests).toHaveLength(1);
  await handle({
    ...message("6", "Объясни", true),
    reference: { messageId: "2" },
    fetchReference: async () => second,
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].conversation[0].content).toContain("Первая часть\nВторая часть");
});

test("Telegram joins private requests and speech continuations and expands voice reply targets", async () => {
  const requests: TestSessionOptions[] = [];
  const voices: string[] = [];
  const bot = createTelegramBot({
    config: { messageBatchWindowMs: 15 },
    assistant: {
      createSession(options) {
        requests.push(options);
        return { stop() {}, run: async () => ({ text: "" }) };
      },
    },
    generateVoice: async (text) => {
      voices.push(text);
      return recording();
    },
    api: async (method) =>
      method === "getMe" ? { id: 99, username: "testbot" } : { message_id: 90 },
  });
  onTestFinished(() => {
    bot.stop();
  });
  const base = { from: { id: 1, first_name: "Alice" }, chat: { id: 1, type: "private" as const } };
  const first = { ...base, message_id: 1, text: "Начало" };
  const second = { ...base, message_id: 2, text: "продолжение" };
  await Promise.all([bot.handleUpdate({ message: first }), bot.handleUpdate({ message: second })]);
  expect(requests).toHaveLength(1);
  expect(requests[0].conversation.at(-1).content).toContain("Начало\nпродолжение");
  await bot.handleUpdate({
    message: { ...base, message_id: 3, text: "!voice", reply_to_message: second },
  });
  expect(voices).toEqual(["Начало\nпродолжение"]);
  await Promise.all([
    bot.handleUpdate({
      message: { ...base, message_id: 4, text: "!voice --speaker xenia Привет" },
    }),
    bot.handleUpdate({ message: { ...base, message_id: 5, text: "ещё раз" } }),
  ]);
  expect(voices.at(-1)).toBe("Привет\nещё раз");
  expect(requests).toHaveLength(1);
  await bot.handleUpdate({
    message: { ...base, message_id: 6, text: "Объясни", reply_to_message: second },
  });
  expect(requests).toHaveLength(2);
  expect(requests[1].conversation[0].content).toContain("Начало\nпродолжение");
});

test("Telegram preserves shifted mentions and images across a grouped request", async () => {
  const requests: TestSessionOptions[] = [];
  const api = Object.assign(
    async (method: string) =>
      method === "getMe" ? { id: 99, username: "testbot" } : { message_id: 90 },
    { downloadImage: async (id: string) => `image:${id}` },
  );
  const bot = createTelegramBot({
    config: { messageBatchWindowMs: 15 },
    api,
    assistant: {
      createSession(options) {
        requests.push(options);
        return { stop() {}, run: async () => ({ text: "" }) };
      },
    },
  });
  onTestFinished(() => {
    bot.stop();
  });
  const base = {
    from: { id: 1, first_name: "Alice" },
    chat: { id: -1, type: "supergroup" as const },
  };
  await Promise.all([
    bot.handleUpdate({
      message: { ...base, message_id: 1, caption: "Первая картинка", photo: [{ file_id: "one" }] },
    }),
    bot.handleUpdate({
      message: {
        ...base,
        message_id: 2,
        caption: "@testbot сравни",
        caption_entities: [{ type: "mention", offset: 0, length: 8 }],
        photo: [{ file_id: "two" }],
      },
    }),
  ]);
  expect(requests).toHaveLength(1);
  expect(requests[0].conversation.at(-1).content).toContain("Первая картинка\n@testbot сравни");
  expect(requests[0].conversation.at(-1).images).toEqual(["image:one", "image:two"]);
});
