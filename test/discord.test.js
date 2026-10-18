/** @file Regression tests for discord.test. */
import test from "node:test";
import assert from "node:assert/strict";
import { Events } from "discord.js";
import { createDiscordBot } from "../src/adapters/discord.js";

test("Discord maps messages to plain input and renders core updates", async (t) => {
  let input;
  const payloads = [];
  const bot = createDiscordBot({ config: {}, assistant: {
    createSession(options) {
      input = options;
      return { stop() {}, async run() {
        await options.onUpdate({ text: "", status: "", thinkingLog: "", liveThinking: "", final: false, modelAlias: "терн" });
        await options.onUpdate({ text: "", status: "", thinkingLog: "reasoning", liveThinking: "reasoning", final: false, modelAlias: "терн" });
        await options.onUpdate({ text: "hello", status: { function: { name: "web_search", arguments: { query: "question" } } }, thinkingLog: "reasoning", liveThinking: "", final: false, modelAlias: "терн" });
        await options.onUpdate({ text: "hello", status: "", thinkingLog: "reasoning", liveThinking: "", final: true, modelAlias: "терн" });
      }};
    },
  }});
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  const reply = { async edit(payload) { payloads.push(payload); } };
  const message = {
    id: "request", author: { id: "user", username: "Alice", bot: false },
    content: "question /think", mentions: { has: () => true },
    channel: { isThread: () => false, messages: { fetch: async () => new Map() } },
    async reply(payload) { payloads.push(payload); return reply; },
  };
  // Await the registered async listener directly so assertions include all edits.
  await bot.client.listeners(Events.MessageCreate)[0](message);
  assert.deepEqual(input.conversation, [{ role: "user", content: "[Автор: Alice (username: Alice, id: user)]\nquestion" }]);
  assert.equal(input.think, true);
  assert.equal(input.search, undefined);
  assert.match(input.platformInstructions, /Discord/);
  assert.equal(payloads[0].content, "…\n\n-# терн");
  assert.ok(payloads.every((payload) => payload.content.endsWith("\n\n-# терн")));
  assert.equal(payloads[0].components.length, 1);
  assert.deepEqual(payloads.at(-1).components, []);
  assert.ok(payloads.every((payload) => !payload.files && !payload.content.includes("reasoning")));
  assert.equal(payloads.at(-1).content, "hello\n\n-# терн");
});

test("Discord uses only the reply chain and never fetches nearby channel messages", async (t) => {
  let input;
  const entry = (id, content, author = { id: "other", username: "Bob", bot: false }) => ({
    id, content, author, type: 0,
  });
  const referenced = entry("20", "earlier answer", { id: "bot", username: "Bot", bot: true });
  const bot = createDiscordBot({ config: {}, assistant: {
    createSession(options) { input = options; return { stop() {}, async run() {} }; },
  } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  const message = {
    ...entry("40", "explain that"), mentions: { has: () => false },
    reference: { messageId: "20" }, fetchReference: async () => referenced,
    channel: { isThread: () => false, messages: { fetch() { assert.fail("must not fetch channel history"); } } },
  };
  await bot.client.listeners(Events.MessageCreate)[0](message);
  assert.deepEqual(input.background, []);
  assert.equal(input.conversation.length, 2);
  assert.equal(input.conversation[0].role, "assistant");
  assert.match(input.conversation.at(-1).content, /explain that/);
  assert.equal(input.search, undefined);
});

test("unaddressed channel messages do not trigger history fetching or generation", async (t) => {
  const bot = createDiscordBot({ config: {}, assistant: {
    createSession() { assert.fail("should not generate"); },
  } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({
    author: { bot: false }, mentions: { has: () => false },
    channel: { isThread: () => false, messages: { fetch() { assert.fail("should not fetch"); } } },
  });
});

test("history permission errors do not prevent answering the current request", async (t) => {
  let input;
  const bot = createDiscordBot({ config: {}, assistant: {
    createSession(options) { input = options; return { stop() {}, async run() {} }; },
  } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40", content: "question", author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true },
    channel: { isThread: () => false, messages: { async fetch() { throw new Error("Missing access"); } } },
  });
  assert.deepEqual(input.background, []);
  assert.match(input.conversation.at(-1).content, /question/);
});

test("Discord image attachments reach the core alongside their caption", async (t) => {
  let input;
  const bot = createDiscordBot({ config: {}, loadImage: async (url) => {
    assert.equal(url, "https://cdn.discordapp.com/photo.png");
    return "base64-image";
  }, assistant: { createSession(options) {
    input = options;
    return { stop() {}, async run() {} };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "10", content: "describe", author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true }, attachments: new Map([["file", {
      contentType: "image/png", url: "https://cdn.discordapp.com/photo.png",
    }]]), channel: { isThread: () => false, messages: { fetch: async () => new Map() } },
  });
  assert.deepEqual(input.conversation[0].images, ["base64-image"]);
  assert.match(input.conversation[0].content, /describe/);
});

test("bot-owned threads do not inject starter or thread history without a reply", async (t) => {
  let input;
  const bot = createDiscordBot({ config: {}, assistant: { createSession(options) {
    input = options;
    return { stop() {}, async run() {} };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40", content: "new question", author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => false }, channel: {
      isThread: () => true, ownerId: "bot",
      fetchStarterMessage() { assert.fail("must not fetch starter"); },
      messages: { fetch() { assert.fail("must not fetch thread history"); } },
    },
  });
  assert.equal(input.conversation.length, 1);
  assert.deepEqual(input.background, []);
});

test("history is fetched only when the scoped Discord reader is called", async (t) => {
  let input;
  let calls = 0;
  const bot = createDiscordBot({ config: {}, assistant: { createSession(options) {
    input = options;
    return { stop() {}, async run() {} };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40", content: "history?", author: { id: "user", username: "Alice", bot: false },
    mentions: { has: () => true }, channel: { isThread: () => false, messages: { async fetch(options) {
      calls++;
      assert.deepEqual(options, { limit: 5, before: "40" });
      return new Map([["30", { id: "30", content: "older", author: { id: "user", username: "Alice", bot: false } }]]);
    } } },
  });
  assert.equal(calls, 0);
  assert.equal((await input.context.readHistory(5)).messages[0].content, "older");
  assert.equal(calls, 1);
});

test("ordinary Discord group messages are observed without triggering a reply", async (t) => {
  const observed = [];
  const bot = createDiscordBot({ config: {}, assistant: {
    observeMessage(entry) { observed.push(entry); },
    createSession() { assert.fail("ordinary message must not trigger generation"); },
  } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({ id: "10", content: "Releases are on Friday", guildId: "123",
    author: { id: "user", username: "Alice", bot: false }, mentions: { has: () => false },
    channel: { id: "channel-1", isThread: () => false },
  });
  assert.equal(observed[0].scopeId, "123");
  assert.equal(observed[0].text, "Releases are on Friday");
});

test("Discord media-only replies have no caption and remove the placeholder", async (t) => {
  const payloads = [];
  let deleted = 0;
  const bot = createDiscordBot({ config: {}, assistant: { createSession(options) {
    return { stop() {}, async run() {
      await options.onUpdate({ text: "", final: false });
      await options.context.sendImage({ url: "https://example.org/cat.gif", title: "Cat", sourceUrl: "https://example.org/", provider: "KLIPY" });
      await options.onUpdate({ text: "", final: true });
      return { text: "" };
    } };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  const message = { id: "media-request", author: { id: "user", username: "Alice", bot: false },
    content: "cat gif", mentions: { has: () => true },
    channel: { isThread: () => false, messages: { fetch: async () => new Map() } },
    async reply(payload) { payloads.push(payload); return { async delete() { deleted++; }, async edit() {} }; },
  };
  await bot.client.listeners(Events.MessageCreate)[0](message);
  const media = payloads.find((payload) => payload.embeds);
  assert.deepEqual(media.embeds, [{ image: { url: "https://example.org/cat.gif" } }]);
  assert.equal(media.content, undefined);
  assert.equal(deleted, 1);
});

test("Discord thread history includes its parent channel and tolerates missing access", async (t) => {
  let input;
  let parentError = false;
  const calls = [];
  const entry = (id, content) => ({ id, content, author: { id: "user", username: "Alice", bot: false } });
  const bot = createDiscordBot({ config: {}, assistant: { createSession(options) {
    input = options;
    return { stop() {}, async run() {} };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  const parent = { id: "channel", name: "general", messages: { async fetch(options) {
    calls.push(options);
    if (parentError) throw new Error("Missing access");
    return new Map([["30", entry("30", "parent discussion")],
      ["20", { id: "20", content: "other bot", author: { id: "other-bot", bot: true } }]]);
  } } };
  await bot.client.listeners(Events.MessageCreate)[0]({
    ...entry("40", "read channel history"), mentions: { has: () => true },
    channel: { id: "thread", name: "topic", isThread: () => true, parent,
      messages: { async fetch(options) {
        calls.push(options);
        return new Map([["35", entry("35", "thread discussion")]]);
      } },
    },
  });
  assert.equal(calls.length, 0);
  const history = await input.context.readHistory(5);
  assert.deepEqual(calls, [{ limit: 5, before: "40" }, { limit: 5, before: "40" }]);
  assert.deepEqual(history.messages.map(({ content, channelId }) => ({ content, channelId })), [
    { content: "parent discussion", channelId: "channel" },
    { content: "thread discussion", channelId: "thread" },
  ]);
  parentError = true;
  const limited = await input.context.readHistory(5);
  assert.equal(limited.limited, true);
  assert.equal(limited.messages[0].content, "thread discussion");
  assert.match(limited.note, /родительский канал/);
});

test("Discord keeps parent history within the tool's total message limit", async (t) => {
  const { createToolService } = await import("../src/core/tools.js");
  let input;
  const bot = createDiscordBot({ config: {}, assistant: { createSession(options) {
    input = options;
    return { stop() {}, async run() {} };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  const channel = (id) => ({ id, messages: { async fetch({ limit }) {
    return new Map(Array.from({ length: limit }, (_, i) => [String(i), {
      id: String(i), content: `${id}-${i}`, author: { id: "user", username: "Alice" },
    }]));
  } } });
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40", content: "history", author: { id: "user", username: "Alice" },
    mentions: { has: () => true },
    channel: { ...channel("thread"), isThread: () => true, parent: channel("parent") },
  });
  const tools = createToolService({ memory: {}, fallbackClient: null });
  for (const limit of [1, 2, 5, 20]) {
    const result = JSON.parse(await tools.runTool({ function: {
      name: "read_history", arguments: { limit },
    } }, input.context));
    assert.equal(result.messages.length, limit);
    assert.ok(result.messages.some((entry) => entry.channelId === "parent"));
    if (limit > 1) assert.ok(result.messages.some((entry) => entry.channelId === "thread"));
  }
});

test("Discord removes the extra message when a temporary status disappears", async (t) => {
  const replies = [];
  let deleted = 0;
  const send = async (payload) => {
    const reply = { payload, reply: send,
      async edit(next) { this.payload = next; },
      async delete() { deleted++; },
    };
    replies.push(reply);
    return reply;
  };
  const bot = createDiscordBot({ config: {}, assistant: { createSession(options) {
    return { stop() {}, async run() {
      await options.onUpdate({ text: "x".repeat(1990), final: false,
        status: { function: { name: "read_history" } } });
      assert.equal(replies.length, 2);
      await options.onUpdate({ text: "x".repeat(1990), final: true });
    } };
  } } });
  t.after(() => bot.client.destroy());
  bot.client.user = { id: "bot" };
  await bot.client.listeners(Events.MessageCreate)[0]({
    id: "40", content: "hello", author: { id: "user", username: "Alice" },
    mentions: { has: () => true }, channel: { isThread: () => false }, reply: send,
  });
  assert.equal(deleted, 1);
  assert.equal(replies[0].payload.content, "x".repeat(1990));
  assert.deepEqual(replies[0].payload.components, []);
});
