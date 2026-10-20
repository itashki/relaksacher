/** @file Regression coverage for discord history behavior. */
import { fixture } from "../support/fixtures.ts";
import type { TestSessionOptions } from "../support/fixtures.ts";
import type { ClientUser } from "discord.js";
import { expect, test, onTestFinished } from "bun:test";
import { Events } from "discord.js";
import { createDiscordBot } from "../support/fixtures.ts";

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
  const { createToolService } = await import("../support/fixtures.ts");
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
