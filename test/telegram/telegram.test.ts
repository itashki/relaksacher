/** @file Regression coverage for telegram behavior. */
import type { TestSessionOptions } from "../support/fixtures.ts";
import type { ObservedMessage } from "../../src/types.ts";
import { expect, test } from "bun:test";
import { createTelegramBot } from "../support/fixtures.ts";
import { setup, message, type TelegramPayload } from "../support/telegram-fixture.ts";

test("private chats render the model signature and do not include unrelated previous messages", async () => {
  const { bot, calls, inputs } = setup();
  await bot.handleUpdate({ message: message(1, "hello /think") });
  const send = calls.find((c) => c.method === "sendMessage");
  expect(send.payload.text).toBe("…\n\n· терн");
  expect(send.payload.reply_markup.inline_keyboard.length).toBe(1);
  expect(inputs[0].think).toBe(true);
  expect(inputs[0].context.scopeId).toBe(undefined);
  expect(inputs[0].context.chatId).toBe("telegram_1:0");
  await bot.handleUpdate({ message: message(100, "next") });
  expect(inputs[1].conversation.length).toBe(1);
  expect(inputs[1].conversation[0].content).toMatch(/next/);
  expect(inputs[1].background).toStrictEqual([]);
  expect(
    calls.some((c) => c.method === "editMessageText" && c.payload.text === "answer\n\n· терн"),
  ).toBeTruthy();
});

test.each([
  ["@testbot question", "question"],
  ["  @TestBot\nquestion /think", "question"],
  ["@testbot: question", ": question"],
  ["@testbot_other question", "@testbot_other question"],
  ["@other question", "@other question"],
  ["question @testbot", "question @testbot"],
  ["@testbot", ""],
])("Telegram strips only its own leading username: %s", async (text, expected) => {
  const { bot, inputs } = setup();
  await bot.handleUpdate({ message: message(1, text) });
  expect(inputs[0].conversation[0].content).toBe(
    `[Автор: Alice (username: нет, id: 10)]\n${expected}`,
  );
});

test("Telegram strips a leading text mention of itself", async () => {
  const { bot, inputs } = setup();
  await bot.handleUpdate({
    message: {
      ...message(1, "Bot question"),
      entities: [
        {
          type: "text_mention",
          offset: 0,
          length: 3,
          user: { id: 99, is_bot: true, first_name: "Bot" },
        },
      ],
    },
  });
  expect(inputs[0].conversation[0].content).toBe(
    "[Автор: Alice (username: нет, id: 10)]\nquestion",
  );
});

test("group messages outside the reply chain are excluded", async () => {
  const { bot, inputs } = setup();
  const chat = { id: -123, type: "supergroup" as const };
  await bot.handleUpdate({ message: { ...message(1, "chatter", chat), message_thread_id: 2 } });
  await bot.handleUpdate({ message: { ...message(2, "other topic", chat), message_thread_id: 3 } });
  expect(inputs.length).toBe(0);
  const addressed = {
    ...message(3, "@testbot question", chat),
    message_thread_id: 2,
    entities: [{ type: "mention" as const, offset: 0, length: 8 }],
  };
  await bot.handleUpdate({ message: addressed });
  expect(inputs[0].context.scopeId).toBe("telegram_-123");
  expect(inputs[0].context.chatId).toBe("telegram_-123:2");
  expect(inputs[0].background).toStrictEqual([]);
  expect(inputs[0].conversation.length).toBe(1);
});

test("stop callbacks reject strangers and allow the requesting author", async () => {
  const { bot, calls } = setup(async (options, instance) => {
    await options.onUpdate({ text: "", modelAlias: "шип", final: false });
    for (const user of [20, 10])
      await instance.handleUpdate({
        callback_query: {
          id: String(user),
          data: "stop:1:1",
          from: { id: user },
          message: { chat: { id: 1, type: "private" } },
        },
      });
    return { text: "stopped" };
  });
  await bot.handleUpdate({ message: message(1, "question") });
  expect(calls.filter((c) => c.method === "stopped").length).toBe(1);
  expect(calls.find((c) => c.method === "answerCallbackQuery").payload.text).toMatch(/автор/);
});

test("long replies respect Telegram text limits and thinking is not sent", async () => {
  const { bot, calls } = setup(async (options) => {
    await options.onUpdate({ text: "😀".repeat(3000), modelAlias: "жало", final: true });
    return { text: "😀".repeat(3000), thinkingLog: "reasoning" };
  });
  await bot.handleUpdate({ message: message(1, "question") });
  const sends = calls.filter((c) => c.method === "sendMessage");
  expect(sends.length).toBe(2);
  expect(sends.every((c) => c.payload.text.length <= 4096)).toBeTruthy();
  expect(!calls.some((c) => c.method === "sendDocument")).toBeTruthy();
});

test("Telegram photos and image replies reach the core as images", async () => {
  const inputs: TestSessionOptions[] = [];
  const loaded: string[] = [];
  const api = async (method: string) =>
    method === "getMe" ? { id: 99, username: "testbot" } : true;
  api.downloadImage = async (file: string) => {
    loaded.push(file);
    return "base64-image";
  };
  const bot = createTelegramBot({
    config: {},
    api,
    assistant: {
      createSession(options) {
        inputs.push(options);
        return {
          stop() {},
          async run() {
            return { text: "description" };
          },
        };
      },
    },
  });
  const photo = { ...message(1, undefined), photo: [{ file_id: "small" }, { file_id: "large" }] };
  await bot.handleUpdate({ message: photo });
  expect(loaded).toStrictEqual(["large"]);
  expect(inputs[0].conversation[0].images).toStrictEqual(["base64-image"]);
  expect(inputs[0].conversation[0].content).toMatch(/Опиши изображение/);
  await bot.handleUpdate({ message: { ...message(2, "what color?"), reply_to_message: photo } });
  expect(inputs[1].conversation[0].images).toStrictEqual(["base64-image"]);
});

test("Telegram keeps cached ancestors only when explicitly replying", async () => {
  const { bot, inputs, calls } = setup();
  await bot.handleUpdate({ message: message(1, "original question") });
  const botReply = calls.find((call) => call.method === "sendMessage");
  // setup returns calls.length as the sent message id (getMe then sendMessage).
  const replyId = 2;
  expect(botReply).toBeTruthy();
  await bot.handleUpdate({
    message: {
      ...message(100, "follow-up"),
      reply_to_message: {
        message_id: replyId,
        text: "answer",
        from: { id: 99, username: "testbot", is_bot: true },
      },
    },
  });
  expect(inputs[1].conversation.length).toBe(3);
  expect(inputs[1].conversation[0].content).toMatch(/original question/);
  expect(inputs[1].conversation[1].role).toBe("assistant");
  expect(inputs[1].conversation[2].content).toMatch(/follow-up/);
});

test("selected reply fragment is passed separately from the user's request and commands", async () => {
  const { bot, inputs } = setup();
  await bot.handleUpdate({
    message: {
      ...message(100, "Что ты имел в виду?"),
      reply_to_message: {
        message_id: 50,
        text: "first topic; /search second topic",
        from: { id: 99, username: "testbot", is_bot: true },
      },
      quote: { text: "/search second topic", position: 13, is_manual: true },
    },
  });
  const current = inputs[0].conversation.at(-1).content;
  expect(current).toMatch(/Цитируемый фрагмент/);
  expect(current).toMatch(/"text":"\/search second topic"/);
  expect(current).toMatch(/"manuallySelected":true/);
  expect(current).toMatch(/"messageId":50/);
  expect(current).toMatch(/Текст реплики:\nЧто ты имел в виду/);
  expect(inputs[0].search).toBe(undefined);
  expect(inputs[0].conversation[0].content).toBe("first topic; /search second topic");
});

test("quoted fragment is retained even when the original message is inaccessible", async () => {
  const { bot, inputs } = setup();
  await bot.handleUpdate({
    message: {
      ...message(101, "Объясни это"),
      quote: { text: "fragment from another chat", position: 0 },
      external_reply: { message_id: 33 },
    },
  });
  expect(inputs[0].conversation.length).toBe(1);
  expect(inputs[0].conversation[0].content).toMatch(/fragment from another chat/);
  expect(inputs[0].conversation[0].content).toMatch(/"manuallySelected":false/);
});

test("history tool reads only cached prior messages in the current topic", async () => {
  const { bot, inputs } = setup();
  const chat = { id: -123, type: "supergroup" as const };
  await bot.handleUpdate({ message: { ...message(1, "same topic", chat), message_thread_id: 2 } });
  await bot.handleUpdate({ message: { ...message(2, "other topic", chat), message_thread_id: 3 } });
  await bot.handleUpdate({
    message: {
      ...message(3, "@testbot history?", chat),
      message_thread_id: 2,
      entities: [{ type: "mention" as const, offset: 0, length: 8 }],
    },
  });
  expect(inputs[0].conversation.length).toBe(1);
  const history = await inputs[0].context.readHistory(10);
  expect(history.messages.map((entry) => entry.content)).toStrictEqual(["same topic"]);
  expect(history.limited).toBe(true);
});

test("ordinary Telegram group messages are observed without replying", async () => {
  const observed: ObservedMessage[] = [];
  const bot = createTelegramBot({
    config: {},
    api: async () => ({ id: 99, username: "testbot" }),
    assistant: {
      observeMessage(entry) {
        observed.push(entry);
      },
      createSession() {
        throw new Error("ordinary message must not trigger generation");
      },
    },
  });
  await bot.handleUpdate({
    message: message(1, "Releases are on Friday", { id: -123, type: "supergroup" }),
  });
  expect(observed[0].scopeId).toBe("telegram_-123");
  expect(observed[0].authorName.includes("Alice")).toBe(true);
});

test("a selected spontaneous group reply reaches the assistant with a short-response hint", async () => {
  let input: TestSessionOptions;
  const bot = createTelegramBot({
    config: {},
    api: async () => ({ id: 99, username: "testbot" }),
    assistant: {
      async considerMessage() {
        return { angle: "light joke" };
      },
      createSession(options) {
        input = options;
        return {
          stop() {},
          async run() {
            return { text: "joke" };
          },
        };
      },
    },
  });
  await bot.handleUpdate({
    message: message(1, "a funny statement", { id: -123, type: "supergroup" }),
  });
  expect(input.platformInstructions).toMatch(/без пинга/);
  expect(input.platformInstructions).toMatch(/light joke/);
});

test("captionless media does not send placeholder text or author names to auto-memory", async () => {
  const observed: ObservedMessage[] = [];
  const bot = createTelegramBot({
    config: {},
    api: async () => ({ id: 99, username: "testbot" }),
    assistant: {
      observeMessage(entry) {
        observed.push(entry);
      },
      createSession() {
        throw new Error("unaddressed media");
      },
    },
  });
  await bot.handleUpdate({
    message: {
      ...message(1, undefined, { id: -123, type: "supergroup" }),
      photo: [{ file_id: "photo" }],
    },
  });
  await bot.handleUpdate({
    message: {
      ...message(2, undefined, { id: -123, type: "supergroup" }),
      animation: { file_id: "gif" },
    },
  });
  expect(observed).toStrictEqual([]);
});

test("searched images are sent to Telegram without captions", async () => {
  const calls: { method: string; payload?: TelegramPayload }[] = [];
  const bot = createTelegramBot({
    config: {},
    api: async (method, payload) => {
      calls.push({ method, payload });
      return method === "getMe" ? { id: 99, username: "testbot" } : true;
    },
    assistant: {
      createSession({ context }) {
        return {
          stop() {},
          async run() {
            await context.sendImage({
              title: "Elephant",
              url: "https://upload.wikimedia.org/elephant.jpg",
              sourceUrl: "https://commons.wikimedia.org/wiki/File:Elephant.jpg",
              author: "Artist",
              license: "CC BY-SA",
            });
            return { text: "image" };
          },
        };
      },
    },
  });
  await bot.handleUpdate({ message: message(1, "show an elephant") });
  const photo = calls.find((call) => call.method === "sendPhoto");
  expect(photo.payload.chat_id).toBe(1);
  expect(photo.payload.caption).toBe(undefined);
  expect(photo.payload.photo).toBe("https://upload.wikimedia.org/elephant.jpg");
});

test("GIF results use Telegram sendAnimation without captions", async () => {
  const { bot, calls } = setup(async ({ context }) => {
    await context.sendImage({
      title: "Cat",
      kind: "gif",
      provider: "KLIPY",
      url: "https://static.klipy.com/cat.gif",
      sourceUrl: "https://klipy.com/gifs/cat",
    });
    return { text: "GIF" };
  });
  await bot.handleUpdate({ message: message(1, "send a cat gif") });
  const animation = calls.find((call) => call.method === "sendAnimation");
  expect(animation.payload.animation).toBe("https://static.klipy.com/cat.gif");
  expect(animation.payload.caption).toBe(undefined);
  expect(animation.payload.reply_parameters.message_id).toBe(1);
  expect(!calls.some((call) => call.method === "sendPhoto")).toBeTruthy();
});

test("Telegram media-only replies remove the temporary text message", async () => {
  const { bot, calls } = setup(async ({ context, onUpdate }) => {
    await onUpdate({ text: "", final: false });
    await context.sendImage({
      title: "GIF",
      sourceUrl: "https://example.org",
      kind: "gif",
      url: "https://static.klipy.com/cat.gif",
    });
    await onUpdate({ text: "", final: true });
    return { text: "" };
  });
  await bot.handleUpdate({ message: message(1, "cat gif") });
  const placeholder = calls.find((call) => call.method === "sendMessage");
  const deletion = calls.find((call) => call.method === "deleteMessage");
  expect(placeholder).toBeTruthy();
  expect(deletion).toBeTruthy();
  expect(deletion.payload.chat_id).toBe(1);
  expect(calls.filter((call) => call.method === "sendMessage").length).toBe(1);
  expect(!calls.some((call) => call.method === "editMessageText")).toBeTruthy();
});
