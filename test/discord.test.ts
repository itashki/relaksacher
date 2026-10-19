/** @file Regression coverage for discord behavior and its external boundaries. */
import { fixture } from "./fixtures.ts";
import type { TestSessionOptions } from "./fixtures.ts";
import type { ClientUser, MessageCreateOptions } from "discord.js";
import { expect, test, onTestFinished } from "bun:test";
import { Events } from "discord.js";
import { createDiscordBot } from "./fixtures.ts";

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

test("Discord uses only the reply chain and never fetches nearby channel messages", async () => {
  let input: TestSessionOptions;
  const entry = (
    id: string,
    content: string,
    author = { id: "other", username: "Bob", bot: false },
  ) => ({
    id,
    content,
    author,
    type: 0,
  });
  const referenced = entry("20", "earlier answer", { id: "bot", username: "Bot", bot: true });
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
  const message = {
    ...entry("40", "explain that"),
    mentions: { has: () => false },
    reference: { messageId: "20" },
    fetchReference: async () => referenced,
    channel: {
      isThread: () => false,
      messages: {
        fetch() {
          throw new Error("must not fetch channel history");
        },
      },
    },
  };
  await bot.client.listeners(Events.MessageCreate)[0](message);
  expect(input.background).toStrictEqual([]);
  expect(input.conversation.length).toBe(2);
  expect(input.conversation[0].role).toBe("assistant");
  expect(input.conversation.at(-1).content).toMatch(/explain that/);
  expect(input.search).toBe(undefined);
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

test("history permission errors do not prevent answering the current request", async () => {
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
    id: "40",
    content: "question",
    author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true },
    channel: {
      isThread: () => false,
      messages: {
        async fetch() {
          throw new Error("Missing access");
        },
      },
    },
  });
  expect(input.background).toStrictEqual([]);
  expect(input.conversation.at(-1).content).toMatch(/question/);
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

test("bot-owned threads do not inject starter or thread history without a reply", async () => {
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
    id: "40",
    content: "new question",
    author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => false },
    channel: {
      isThread: () => true,
      ownerId: "bot",
      fetchStarterMessage() {
        throw new Error("must not fetch starter");
      },
      messages: {
        fetch() {
          throw new Error("must not fetch thread history");
        },
      },
    },
  });
  expect(input.conversation.length).toBe(1);
  expect(input.background).toStrictEqual([]);
});

test("history is fetched only when the scoped Discord reader is called", async () => {
  let input: TestSessionOptions;
  let calls = 0;
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
    id: "40",
    content: "history?",
    author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true },
    channel: {
      isThread: () => false,
      messages: {
        async fetch(options: { limit: number; before?: string }) {
          calls++;
          expect(options).toStrictEqual({ limit: 5, before: "40" });
          return new Map<
            string,
            { id: string; content: string; author: { id: string; username?: string; bot: boolean } }
          >([
            [
              "30",
              { id: "30", content: "older", author: { id: "user", username: "Alice", bot: false } },
            ],
          ]);
        },
      },
    },
  });
  expect(calls).toBe(0);
  expect((await input.context.readHistory(5)).messages[0].content).toBe("older");
  expect(calls).toBe(1);
});

test("ordinary Discord group messages are observed without triggering a reply", async () => {
  const observed: import("../src/types.ts").ObservedMessage[] = [];
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

test("Discord thread history includes its parent channel and tolerates missing access", async () => {
  let input: TestSessionOptions;
  let parentError = false;
  const calls: { limit: number; before?: string }[] = [];
  const entry = (id: string, content: string) => ({
    id,
    content,
    author: { id: "user", username: "Alice", bot: false },
  });
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
  const parent = {
    id: "channel",
    name: "general",
    messages: {
      async fetch(options: { limit: number; before?: string }) {
        calls.push(options);
        if (parentError) throw new Error("Missing access");
        return new Map<
          string,
          { id: string; content: string; author: { id: string; username?: string; bot: boolean } }
        >([
          ["30", entry("30", "parent discussion")],
          ["20", { id: "20", content: "other bot", author: { id: "other-bot", bot: true } }],
        ]);
      },
    },
  };
  await bot.client.listeners(Events.MessageCreate)[0]({
    ...entry("40", "read channel history"),
    mentions: { has: () => true },
    channel: {
      id: "thread",
      name: "topic",
      isThread: () => true,
      parent,
      messages: {
        async fetch(options: { limit: number; before?: string }) {
          calls.push(options);
          return new Map([["35", entry("35", "thread discussion")]]);
        },
      },
    },
  });
  expect(calls.length).toBe(0);
  const history = await input.context.readHistory(5);
  expect(calls).toStrictEqual([
    { limit: 5, before: "40" },
    { limit: 5, before: "40" },
  ]);
  expect(history.messages.map(({ content, channelId }) => ({ content, channelId }))).toStrictEqual([
    { content: "parent discussion", channelId: "channel" },
    { content: "thread discussion", channelId: "thread" },
  ]);
  parentError = true;
  const limited = await input.context.readHistory(5);
  expect(limited.limited).toBe(true);
  expect(limited.messages[0].content).toBe("thread discussion");
  expect(limited.note).toMatch(/родительский канал/);
});

test("Discord keeps parent history within the tool's total message limit", async () => {
  const { createToolService } = await import("./fixtures.ts");
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
  const channel = (id: string) => ({
    id,
    messages: {
      async fetch({ limit }: { limit: number }) {
        return new Map(
          Array.from({ length: limit }, (_, i) => [
            String(i),
            {
              id: String(i),
              content: `${id}-${i}`,
              author: { id: "user", username: "Alice" },
            },
          ]),
        );
      },
    },
  });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40",
    content: "history",
    author: { id: "user", username: "Alice" },
    mentions: { has: () => true },
    channel: { ...channel("thread"), isThread: () => true, parent: channel("parent") },
  });
  const tools = createToolService({ memory: {}, fallbackClient: null });
  for (const limit of [1, 2, 5, 20]) {
    const result = JSON.parse(
      await tools.runTool(
        {
          function: {
            name: "read_history",
            arguments: { limit },
          },
        },
        input.context,
      ),
    );
    expect(result.messages.length).toBe(limit);
    expect(
      result.messages.some((entry: { channelId: string }) => entry.channelId === "parent"),
    ).toBeTruthy();
    if (limit > 1)
      expect(
        result.messages.some((entry: { channelId: string }) => entry.channelId === "thread"),
      ).toBeTruthy();
  }
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
