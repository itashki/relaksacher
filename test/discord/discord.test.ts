/** @file Regression coverage for discord behavior. */
import { fixture } from "../support/fixtures.ts";
import type { TestSessionOptions } from "../support/fixtures.ts";
import type { ClientUser, MessageCreateOptions } from "discord.js";
import { expect, test, onTestFinished } from "bun:test";
import { Events } from "discord.js";
import { createDiscordBot } from "../support/fixtures.ts";

test("Discord maps messages to plain input and renders core updates", async () => {
  let input: TestSessionOptions;
  const payloads: MessageCreateOptions[] = [];
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession(options) {
        input = options;
        return {
          stop() {},
          async run() {
            await options.onUpdate({
              text: "",
              status: "",
              thinkingLog: "",
              liveThinking: "",
              final: false,
              modelAlias: "терн",
            });
            await options.onUpdate({
              text: "",
              status: "",
              thinkingLog: "reasoning",
              liveThinking: "reasoning",
              final: false,
              modelAlias: "терн",
            });
            await options.onUpdate({
              text: "hello",
              status: { function: { name: "web_search", arguments: { query: "question" } } },
              thinkingLog: "reasoning",
              liveThinking: "",
              final: false,
              modelAlias: "терн",
            });
            await options.onUpdate({
              text: "hello",
              status: "",
              thinkingLog: "reasoning",
              liveThinking: "",
              final: true,
              modelAlias: "терн",
            });
          },
        };
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const reply = {
    async edit(payload: MessageCreateOptions) {
      payloads.push(payload);
    },
  };
  const message = {
    id: "request",
    author: { id: "user", username: "Alice", bot: false },
    content: "question /think",
    mentions: { has: () => true },
    channel: { isThread: () => false, messages: { fetch: async () => new Map() } },
    async reply(payload: MessageCreateOptions) {
      payloads.push(payload);
      return reply;
    },
  };
  // Await the registered async listener directly so assertions include all edits.
  await bot.client.listeners(Events.MessageCreate)[0](message);
  expect(input.conversation).toStrictEqual([
    { role: "user", content: "[Автор: Alice (username: Alice, id: user)]\nquestion" },
  ]);
  expect(input.think).toBe(true);
  expect(input.search).toBe(undefined);
  expect(input.platformInstructions).toMatch(/Discord/);
  expect(payloads[0].content).toBe("…\n\n-# терн");
  expect(
    payloads.every((payload: MessageCreateOptions) => payload.content.endsWith("\n\n-# терн")),
  ).toBeTruthy();
  expect(payloads[0].components.length).toBe(1);
  expect(payloads.at(-1).components).toStrictEqual([]);
  expect(
    payloads.every(
      (payload: MessageCreateOptions) => !payload.files && !payload.content.includes("reasoning"),
    ),
  ).toBeTruthy();
  expect(payloads.at(-1).content).toBe("hello\n\n-# терн");
});

test.each([
  ["<@bot> question", "question"],
  ["  <@!bot>\nquestion /think", "question"],
  ["<@other> question", "<@other> question"],
  ["question <@bot>", "question <@bot>"],
  ["<@bot>", ""],
])("Discord strips only its own leading ping: %s", async (content, expected) => {
  let input: TestSessionOptions;
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession(options) {
        input = options;
        return { stop() {}, async run() {} };
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "request",
    content,
    author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true },
    channel: { isThread: () => false },
  });
  expect(input.conversation).toStrictEqual([
    { role: "user", content: `[Автор: Alice (username: Alice, id: user)]\n${expected}` },
  ]);
});

test("unaddressed channel messages do not trigger history fetching or generation", async () => {
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession() {
        throw new Error("should not generate");
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  await bot.client.listeners(Events.MessageCreate)[0]({
    author: { bot: false },
    mentions: { has: () => false },
    channel: {
      isThread: () => false,
      messages: {
        fetch() {
          throw new Error("should not fetch");
        },
      },
    },
  });
});

test("Discord image attachments reach the core alongside their caption", async () => {
  let input: TestSessionOptions;
  const bot = createDiscordBot({
    config: {},
    loadImage: async (url) => {
      expect(url).toBe("https://cdn.discordapp.com/photo.png");
      return "base64-image";
    },
    assistant: {
      createSession(options) {
        input = options;
        return { stop() {}, async run() {} };
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "10",
    content: "describe",
    author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true },
    attachments: new Map([
      [
        "file",
        {
          contentType: "image/png",
          url: "https://cdn.discordapp.com/photo.png",
        },
      ],
    ]),
    channel: { isThread: () => false, messages: { fetch: async () => new Map() } },
  });
  expect(input.conversation[0].images).toStrictEqual(["base64-image"]);
  expect(input.conversation[0].content).toMatch(/describe/);
});

test("ordinary Discord group messages are observed without triggering a reply", async () => {
  const observed: import("../../src/types.ts").ObservedMessage[] = [];
  const bot = createDiscordBot({
    config: {},
    assistant: {
      observeMessage(entry) {
        observed.push(entry);
      },
      createSession() {
        throw new Error("ordinary message must not trigger generation");
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "10",
    content: "Releases are on Friday",
    guildId: "123",
    author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => false },
    channel: { id: "channel-1", isThread: () => false },
  });
  expect(observed[0].scopeId).toBe("123");
  expect(observed[0].text).toBe("Releases are on Friday");
});

test("Discord media-only replies have no caption and remove the placeholder", async () => {
  const payloads: MessageCreateOptions[] = [];
  let deleted = 0;
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession(options) {
        return {
          stop() {},
          async run() {
            await options.onUpdate({ text: "", final: false });
            await options.context.sendImage({
              url: "https://example.org/cat.gif",
              title: "Cat",
              sourceUrl: "https://example.org/",
              provider: "KLIPY",
            });
            await options.onUpdate({ text: "", final: true });
            return { text: "" };
          },
        };
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const message = {
    id: "media-request",
    author: { id: "user", username: "Alice", bot: false },
    content: "cat gif",
    mentions: { has: () => true },
    channel: { isThread: () => false, messages: { fetch: async () => new Map() } },
    async reply(payload: MessageCreateOptions) {
      payloads.push(payload);
      return {
        async delete() {
          deleted++;
        },
        async edit() {},
      };
    },
  };
  await bot.client.listeners(Events.MessageCreate)[0](message);
  const media = payloads.find((payload: MessageCreateOptions) => payload.embeds);
  expect(media.embeds).toStrictEqual([{ image: { url: "https://example.org/cat.gif" } }]);
  expect(media.content).toBe(undefined);
  expect(deleted).toBe(1);
});

test("Discord removes the extra message when a temporary status disappears", async () => {
  const replies: { payload: MessageCreateOptions }[] = [];
  let deleted = 0;
  const send = async (payload: MessageCreateOptions) => {
    const reply = {
      payload,
      reply: send,
      async edit(next: MessageCreateOptions) {
        this.payload = next;
      },
      async delete() {
        deleted++;
      },
    };
    replies.push(reply);
    return reply;
  };
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession(options) {
        return {
          stop() {},
          async run() {
            await options.onUpdate({
              text: "x".repeat(1990),
              final: false,
              status: { function: { name: "read_history", arguments: {} } },
            });
            expect(replies.length).toBe(2);
            await options.onUpdate({ text: "x".repeat(1990), final: true });
          },
        };
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40",
    content: "hello",
    author: { id: "user", username: "Alice" },
    mentions: { has: () => true },
    channel: { isThread: () => false },
    reply: send,
  });
  expect(deleted).toBe(1);
  expect(replies[0].payload.content).toBe("x".repeat(1990));
  expect(replies[0].payload.components).toStrictEqual([]);
});

test("Discord stop returns and reuses the pending client teardown promise", async () => {
  const bot = createDiscordBot({ config: {}, assistant: {} });
  let release: () => void;
  let calls = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  bot.client.destroy = async () => {
    calls++;
    await pending;
  };
  const stopped = bot.stop();
  expect(stopped).toBeInstanceOf(Promise);
  expect(bot.stop()).toBe(stopped);
  expect(calls).toBe(1);
  release();
  await stopped;
});

test("TTS reply to the bot never reaches model generation or observation even on voice access error", async () => {
  const bot = createDiscordBot({
    config: {},
    assistant: {
      createSession() {
        throw new Error("TTS must not invoke the model");
      },
      observeMessage() {
        throw new Error("TTS must not be observed");
      },
      considerMessage() {
        throw new Error("TTS must not trigger spontaneous replies");
      },
    },
  });
  onTestFinished(() => bot.client.destroy());
  bot.client.user = fixture<ClientUser>({ id: "bot" });
  const replies: string[] = [];
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "tts",
    content: "!tts",
    author: { id: "user", bot: false },
    guild: { id: "guild", members: { fetch: async () => ({ voice: { channel: null as null } }) } },
    reference: { messageId: "answer" },
    fetchReference: async () => ({ content: "Мой ответ", author: { id: "bot" } }),
    mentions: { has: () => true },
    reply: async (payload: { content: string }) => {
      replies.push(payload.content);
    },
  });
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain("голосовой канал");
});
