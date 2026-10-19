/** @file Regression coverage for telegram behavior and its external boundaries. */
type TelegramPayload = {
  text?: string;
  chat_id?: number;
  message_id?: number;
  callback_query_id?: string;
  reply_markup?: { inline_keyboard: { callback_data?: string }[][] };
  document?: Blob;
  disable_web_page_preview?: boolean;
  reply_parameters?: { message_id?: number };
  [key: string]: unknown;
};
import type { TestSessionOptions } from "./fixtures.ts";
import type { AppConfig, ObservedMessage } from "../src/types.ts";
import { spyOn, expect, test, onTestFinished } from "bun:test";
import { createTelegramBot, createTelegramApi } from "./fixtures.ts";

/**
 * Build an injected Telegram adapter with no external network requests.
 * @param run Custom fake session execution.
 * @param config Telegram adapter settings.
 * @returns Bot fixture, API calls and captured session options.
 */
function setup(
  run?: (
    options: TestSessionOptions,
    instance: ReturnType<typeof createTelegramBot>,
  ) => Promise<unknown>,
  config: Partial<AppConfig> = { telegramUpdateIntervalMs: 0 },
) {
  const calls: { method: string; payload?: TelegramPayload }[] = [];
  const inputs: TestSessionOptions[] = [];
  const bot = createTelegramBot({
    config,
    api: async (method, payload: TelegramPayload = {}) => {
      calls.push({ method, payload });
      if (method === "getMe") return { id: 99, username: "testbot", is_bot: true };
      if (method === "getChatMember") return { status: "member" };
      return { message_id: calls.length, text: payload.text };
    },
    assistant: {
      createSession(options) {
        inputs.push(options);
        return {
          stop() {
            calls.push({ method: "stopped" });
          },
          async run() {
            if (run) return run(options, bot);
            await options.onUpdate({ text: "", modelAlias: "терн", final: false });
            await options.onUpdate({ text: "answer", modelAlias: "терн", final: true });
            return { text: "answer", thinkingLog: "" };
          },
        };
      },
    },
  });
  return { bot, calls, inputs };
}
/**
 * Build a minimal user-authored Telegram message for adapter tests.
 * @param id Message identifier.
 * @param text Text or undefined for image-only fixtures.
 * @param chat Chat metadata.
 * @returns Message fixture.
 */
const message = (
  id: number,
  text: string,
  chat: { id: number; type: "private" | "group" | "supergroup" } = { id: 1, type: "private" },
) => ({
  message_id: id,
  text,
  chat,
  from: { id: 10, first_name: "Alice" },
});

test("private chats render the model signature and do not include unrelated previous messages", async () => {
  const { bot, calls, inputs } = setup();
  await bot.handleUpdate({ message: message(1, "hello /think") });
  const send = calls.find((c) => c.method === "sendMessage");
  expect(send.payload.text).toBe("…\n\n· терн");
  expect(send.payload.reply_markup.inline_keyboard.length).toBe(1);
  expect(inputs[0].think).toBe(true);
  expect(inputs[0].context.scopeId).toBe(undefined);
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

test("Telegram transport redacts token-bearing fetch errors", async () => {
  const api = createTelegramApi("secret-token", async () => {
    throw new Error("URL contains secret-token");
  });
  await expect(api("getMe")).rejects.toMatchObject({
    message: expect.not.stringContaining("secret-token"),
  });
});

test("Telegram retries a failed edit but does not retry sending new messages", async () => {
  let attempts = 0;
  const api = createTelegramApi("secret", async () => {
    attempts++;
    if (attempts === 1) throw new Error("connection lost");
    return { json: async () => ({ ok: true, result: true }) };
  });
  expect(await api("editMessageText", { chat_id: 1, message_id: 2, text: "answer" })).toBe(true);
  expect(attempts).toBe(2);
  attempts = 0;
  await expect(api("sendMessage", { chat_id: 1, text: "answer" })).rejects.toThrow();
  expect(attempts).toBe(1);
});

test("temporary streaming edit failure does not interrupt generation or lose final text", async () => {
  const spy = spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  let edits = 0;
  let completed = false;
  const bot = createTelegramBot({
    config: { telegramUpdateIntervalMs: 0 },
    api: async (method, payload) => {
      if (method === "getMe") return { id: 99, username: "testbot" };
      if (method === "sendMessage") return { message_id: 2 };
      if (method === "editMessageText") {
        if (++edits === 1) throw Object.assign(new Error("connection failed"), { transient: true });
        expect(payload.text).toBe("complete answer");
      }
      return true;
    },
    assistant: {
      createSession({ onUpdate }) {
        return {
          stop() {},
          async run() {
            await onUpdate({ text: "", final: false });
            await onUpdate({ text: "partial", final: false });
            await onUpdate({ text: "complete answer", final: true });
            completed = true;
            return { text: "complete answer" };
          },
        };
      },
    },
  });
  await bot.handleUpdate({ message: message(1, "question") });
  expect(completed).toBe(true);
  expect(edits).toBe(2);
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

test("grammY uploads thinking.md as multipart and handles Telegram rate limits", async () => {
  const uploads: { type: string; body: string }[] = [];
  const api = createTelegramApi("test-token", async (_url, init) => {
    uploads.push({
      type: new Headers(init.headers).get("content-type"),
      body: await new Response(init.body).text(),
    });
    return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  await api("sendDocument", {
    chat_id: 1,
    document: new Blob(["reasoning"], { type: "text/markdown" }),
  });
  expect(uploads[0].type).toMatch(/multipart\/form-data/);
  expect(uploads[0].body).toMatch(/thinking.md/);
  expect(uploads[0].body).toMatch(/reasoning/);
  let calls = 0;
  const limited = createTelegramApi("test-token", async () => ({
    json: async () =>
      ++calls === 1
        ? {
            ok: false,
            error_code: 429,
            description: "Too many requests",
            parameters: { retry_after: 0 },
          }
        : { ok: true, result: true },
  }));
  expect(await limited("sendMessage", { chat_id: 1, text: "hello" })).toBe(true);
  expect(calls).toBe(2);
});

test("grammY runner receives stop callbacks while generation is running", async () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  let startGeneration: () => void;
  const started = new Promise<void>((resolve) => {
    startGeneration = resolve;
  });
  let finishGeneration: () => void;
  const finished = new Promise<void>((resolve) => {
    finishGeneration = resolve;
  });
  let callbackAnswered: () => void;
  const answered = new Promise<void>((resolve) => {
    callbackAnswered = resolve;
  });
  let polls = 0;
  const api = async (method: string, _payload: TelegramPayload, signal: AbortSignal) => {
    if (method === "getMe") return { id: 99, username: "testbot" };
    if (method === "getUpdates") {
      if (++polls === 1) return [{ update_id: 1, message: message(1, "question") }];
      if (polls === 2) {
        await started;
        return [
          {
            update_id: 2,
            callback_query: {
              id: "callback",
              data: "stop:1:1",
              from: { id: 10 },
              message: { chat: { id: 1, type: "private" } },
            },
          },
        ];
      }
      return new Promise<unknown[]>((resolve) => {
        if (signal.aborted) resolve([]);
        else signal.addEventListener("abort", () => resolve([]), { once: true });
      });
    }
    if (method === "answerCallbackQuery") callbackAnswered();
    return true;
  };
  const bot = createTelegramBot({
    config: {},
    api,
    assistant: {
      createSession() {
        return {
          stop: finishGeneration,
          async run() {
            startGeneration();
            await finished;
            return { text: "stopped" };
          },
        };
      },
    },
  });
  onTestFinished(() => bot.stop());
  const running = bot.start();
  await answered;
  await bot.stop();
  await running;
  expect(polls >= 2).toBeTruthy();
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

test("getMe uses grammY's signal-only signature and reaches the transport", async () => {
  let calls = 0;
  const api = createTelegramApi("test-token", async (url, init) => {
    calls++;
    expect(String(url).endsWith("/getMe")).toBeTruthy();
    expect(typeof init.signal.addEventListener).toBe("function");
    expect(init.signal.aborted).toBe(false);
    return { json: async () => ({ ok: true, result: { id: 99, username: "testbot" } }) };
  });
  const me = await api("getMe");
  expect(me.username).toBe("testbot");
  expect(calls).toBe(1);
});

test("a temporary getMe network failure is retried and stays identifiable", async () => {
  let calls = 0;
  const api = createTelegramApi("secret-token", async () => {
    if (++calls === 1) throw new Error("network failure with secret-token");
    return { json: async () => ({ ok: true, result: { id: 99 } }) };
  });
  expect((await api("getMe")).id).toBe(99);
  expect(calls).toBe(2);
  const invalidToken = createTelegramApi("secret-token", async () => ({
    json: async () => ({ ok: false, error_code: 401, description: "Unauthorized" }),
  }));
  await expect(invalidToken("getMe")).rejects.toMatchObject({ code: 401, transient: false });
});

test("grammY transport works with native Bun fetch, not only fetch mocks", async () => {
  const result = { ok: true, result: { id: 99, username: "testbot" } };
  const dataUrl = `data:application/json,${encodeURIComponent(JSON.stringify(result))}`;
  const api = createTelegramApi("test-token", (_url, options) => fetch(dataUrl, options));
  expect((await api("getMe")).username).toBe("testbot");
});

test("native signal bridge forwards request cancellation", async () => {
  let transportStarted: () => void;
  const started = new Promise<void>((resolve) => {
    transportStarted = resolve;
  });
  const api = createTelegramApi("test-token", async (_url, options) => {
    expect(options.signal instanceof AbortSignal).toBeTruthy();
    transportStarted();
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("cancelled")), {
        once: true,
      });
    });
  });
  const controller = new AbortController();
  const request = api("getMe", {}, controller.signal);
  await started;
  controller.abort();
  await expect(request).rejects.toMatchObject({
    transient: false,
    message: expect.stringMatching(/cancelled/),
  });
});

test("real runner signals work through grammY and native fetch to deliver messages", async () => {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  onTestFinished(() => spy.mockRestore());
  let delivered: (options: TestSessionOptions) => void;
  const received = new Promise<TestSessionOptions>((resolve) => {
    delivered = resolve;
  });
  let polls = 0;
  const api = createTelegramApi("test-token", async (url, options) => {
    const method = String(url).split("/").at(-1);
    let result;
    if (method === "getMe") result = { id: 99, username: "testbot" };
    else if (method === "getUpdates") {
      if (++polls === 1) result = [{ update_id: 1, message: message(1, "hello from polling") }];
      else
        return new Promise((_resolve, reject) => {
          if (options.signal.aborted) reject(new Error("aborted"));
          else
            options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
        });
    } else result = true;
    return fetch(
      `data:application/json,${encodeURIComponent(JSON.stringify({ ok: true, result }))}`,
      options,
    );
  });
  const bot = createTelegramBot({
    config: {},
    api,
    assistant: {
      createSession(options) {
        delivered(options);
        return {
          stop() {},
          async run() {
            return { text: "answer" };
          },
        };
      },
    },
  });
  onTestFinished(() => bot.stop());
  const started = bot.start();
  const options = await received;
  expect(options.conversation.at(-1).content).toMatch(/hello from polling/);
  await bot.stop();
  await started;
  expect(polls >= 1).toBeTruthy();
});

test("Telegram throttles intermediate edits but sends initial and final snapshots immediately", async () => {
  let now = 10000;
  const spy = spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => spy.mockRestore());
  const { bot, calls } = setup(
    async ({ onUpdate }) => {
      await onUpdate({ text: "", modelAlias: "терн", final: false });
      for (const delta of [100, 1000, 3000]) {
        now = 10000 + delta;
        await onUpdate({ text: `partial ${delta}`, final: false });
      }
      now = 15000;
      await onUpdate({ text: "latest partial", final: false });
      now = 15100;
      await onUpdate({ text: "complete", final: true });
      return { text: "complete" };
    },
    { telegramUpdateIntervalMs: 5000 },
  );
  await bot.handleUpdate({ message: message(1, "question") });
  expect(calls.filter((call) => call.method === "sendMessage").length).toBe(1);
  expect(
    calls.filter((call) => call.method === "editMessageText").map((call) => call.payload.text),
  ).toStrictEqual(["latest partial", "complete"]);
  expect(calls.filter((call) => call.method === "editMessageReplyMarkup").length).toBe(0);
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
