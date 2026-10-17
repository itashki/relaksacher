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
